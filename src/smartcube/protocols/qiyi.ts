import { Subject } from 'rxjs';
import { ModeOfOperation } from 'aes-js';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, SmartCubeProtocolInfo, MacAddressProvider, SmartCubeRawMessage } from '../types';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { getCachedMacForDevice } from '../attachment/address-hints';
import { buildQiYiMacCandidatesFromName } from '../attachment/mac-candidates';
import { probeQiYiMac } from '../attachment/mac-probe-qiyi';
import { SmartCubeProtocol, registerProtocol } from '../protocol';
import { CubieCube } from '../cubie-cube';
import { now, findCharacteristic, waitForAdvertisements, extractMacFromManufacturerData } from '../ble-utils';
import { writeGattCharacteristicValue } from '../../gatt-characteristic-write';

const UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const SERVICE_UUID = '0000fff0' + UUID_SUFFIX;
const CHRCT_UUID_CUBE = '0000fff6' + UUID_SUFFIX;

const QIYI_CIC_LIST = [0x0504];
const QIYI_KEY = [87, 177, 249, 171, 205, 90, 232, 167, 156, 185, 140, 231, 87, 140, 81, 8];

function crc16modbus(data: number[]): number {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x1) > 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
        }
    }
    return crc;
}

class QiYiEncrypter {
    private cipher: any;

    constructor() {
        this.cipher = new ModeOfOperation.ecb(new Uint8Array(QIYI_KEY));
    }

    encrypt(data: number[]): number[] {
        const result: number[] = [];
        for (let i = 0; i < data.length; i += 16) {
            const block = data.slice(i, i + 16);
            const encrypted = this.cipher.encrypt(new Uint8Array(block));
            for (let j = 0; j < 16; j++) {
                result[i + j] = encrypted[j];
            }
        }
        return result;
    }

    decrypt(data: number[]): number[] {
        const result: number[] = [];
        for (let i = 0; i < data.length; i += 16) {
            const block = data.slice(i, i + 16);
            const decrypted = this.cipher.decrypt(new Uint8Array(block));
            for (let j = 0; j < 16; j++) {
                result[i + j] = decrypted[j];
            }
        }
        return result;
    }
}

function parseFacelet(faceMsg: number[]): string {
    const ret: string[] = [];
    for (let i = 0; i < 54; i++) {
        ret.push("LRDUFB".charAt((faceMsg[i >> 1] >> ((i % 2) << 2)) & 0xf));
    }
    return ret.join("");
}

/** Device timestamps in bytes 3–6 and history slots: big-endian uint32 */
function readQiYiTimestampBE(msg: number[], offset: number): number {
    return (msg[offset]! << 24) | (msg[offset + 1]! << 16) | (msg[offset + 2]! << 8) | msg[offset + 3]!;
}

const QIYI_PROTOCOL: SmartCubeProtocolInfo = { id: 'qiyi', name: 'QiYi', puzzleFamily: '3x3' };

class QiYiConnection implements SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo = QIYI_PROTOCOL;
    readonly capabilities: SmartCubeCapabilities = {
        gyroscope: false,
        battery: true,
        facelets: true,
        hardware: true,
        reset: false
    };
    events$: Subject<SmartCubeEvent>;
    readonly rawMessages$: Subject<SmartCubeRawMessage> = new Subject();

    private device: BluetoothDevice;
    private cubeChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private encrypter: QiYiEncrypter;
    private curCubie = new CubieCube();
    private prevCubie = new CubieCube();
    private lastTs = 0;
    private lastBatteryLevel: number | null = null;
    private forceNextBatteryEmission = false;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(device: BluetoothDevice, mac: string) {
        this.device = device;
        this.deviceName = device.name || 'QiYi';
        this.deviceMAC = mac;
        this.events$ = new Subject<SmartCubeEvent>();
        this.encrypter = new QiYiEncrypter();
    }

    private sendMessage(content: number[]): Promise<void> {
        if (!this.cubeChrct) return Promise.reject();
        const ch = this.cubeChrct;
        const run = async (): Promise<void> => {
            const msg = [0xfe];
            msg.push(4 + content.length);
            for (let i = 0; i < content.length; i++) {
                msg.push(content[i]!);
            }
            const crc = crc16modbus(msg);
            msg.push(crc & 0xff, crc >> 8);
            const npad = (16 - msg.length % 16) % 16;
            for (let i = 0; i < npad; i++) {
                msg.push(0);
            }
            const encMsg = this.encrypter.encrypt(msg);
            await writeGattCharacteristicValue(ch, new Uint8Array(encMsg).buffer);
        };
        this.writeChain = this.writeChain.then(run, run);
        return this.writeChain;
    }

    private sendHello(): Promise<void> {
        const macBytes = this.deviceMAC.split(/[:-\s]+/).map(c => parseInt(c, 16));
        const content = [0x00, 0x6b, 0x01, 0x00, 0x00, 0x22, 0x06, 0x00, 0x02, 0x08, 0x00];
        for (let i = 5; i >= 0; i--) {
            content.push(macBytes[i] || 0);
        }
        return this.sendMessage(content);
    }

    private onCubeEvent = (event: Event): void => {
        const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
        const value = characteristic.value;
        if (!value) return;

        const encMsg: number[] = [];
        for (let i = 0; i < value.byteLength; i++) {
            encMsg[i] = value.getUint8(i);
        }

        const msg = this.encrypter.decrypt(encMsg);
        this.rawMessages$.next({
            timestamp: now(),
            characteristicUuid: characteristic.uuid,
            raw: new Uint8Array(encMsg),
            decrypted: new Uint8Array(msg)
        });

        if (msg[0] === 0xCC && msg[1] === 0x10) {
            this.handleQuaternionPacket(msg);
            return;
        }

        const trimmed = msg.slice(0, msg[1]);
        if (trimmed.length < 3 || crc16modbus(trimmed) !== 0) {
            return;
        }

        this.parseCubeData(trimmed);
    };

    private handleQuaternionPacket(msg: number[]): void {
        if (msg.length < 16) return;

        const expectedCrc = crc16modbus(msg.slice(0, 14));
        const actualCrc = msg[14] | (msg[15] << 8);
        if (expectedCrc !== actualCrc) return;

        if (!this.capabilities.gyroscope) {
            this.capabilities.gyroscope = true;
        }

        const dv = new DataView(Uint8Array.from(msg).buffer);
        const ax = dv.getInt16(6, false) / 1000;
        const ay = dv.getInt16(8, false) / 1000;
        const az = dv.getInt16(10, false) / 1000;
        const aw = dv.getInt16(12, false) / 1000;

        this.events$.next({
            timestamp: now(),
            type: "GYRO",
            quaternion: {
                x: ax,
                y: -az,
                z: ay,
                w: aw
            }
        });
    }

    private emitHardwareEvent(): void {
        this.events$.next({
            timestamp: now(),
            type: "HARDWARE",
            hardwareName: this.deviceName,
            gyroSupported: this.capabilities.gyroscope
        });
    }

    private emitBatteryLevel(rawLevel: number, timestamp = now()): void {
        if (!Number.isFinite(rawLevel)) {
            return;
        }
        const batteryLevel = Math.min(100, Math.max(0, Math.round(rawLevel)));
        const forceEmission = this.forceNextBatteryEmission;
        this.forceNextBatteryEmission = false;
        if (!forceEmission && this.lastBatteryLevel === batteryLevel) {
            return;
        }
        this.lastBatteryLevel = batteryLevel;
        this.events$.next({
            timestamp,
            type: 'BATTERY',
            batteryLevel,
        });
    }

    private parseCubeData(msg: number[]): void {
        const timestamp = now();
        if (msg[0] !== 0xfe) return;

        const opcode = msg[2]!;
        const ts = readQiYiTimestampBE(msg, 3);

        if (opcode === 0x2) {
            // Hello response — always ACK
            this.sendMessage(msg.slice(2, 7)).catch(() => {});
            const newFacelet = parseFacelet(msg.slice(7, 34));

            this.events$.next({
                timestamp,
                type: "FACELETS",
                facelets: newFacelet
            });

            this.emitBatteryLevel(msg[35]!, timestamp);

            this.prevCubie.fromFacelet(newFacelet);
            this.lastTs = ts;
            return;
        }

        if (opcode === 0x3) {
            // Match csTimer: every state-change packet is acknowledged.
            this.sendMessage(msg.slice(2, 7)).catch(() => {});

            // The current move is at byte 34. Up to nine missed moves can be
            // recovered from the newest history slots at bytes 86, 81, ...
            const todoMoves: [number, number][] = [[msg[34]!, ts]];
            while (todoMoves.length < 10) {
                const off = 91 - 5 * todoMoves.length;
                if (off + 4 >= msg.length) break;
                const historyTs = readQiYiTimestampBE(msg, off);
                const historyMove = msg[off + 4]!;
                if (historyTs <= this.lastTs) break;
                todoMoves.push([historyMove, historyTs]);
            }

            let computedFacelet: string | undefined;
            for (let k = todoMoves.length - 1; k >= 0; k--) {
                const [code, moveTs] = todoMoves[k]!;
                if (code < 1 || code > 12) continue;
                const axis = [4, 1, 3, 0, 2, 5][(code - 1) >> 1]!;
                const power = [0, 2][code & 1]!;
                const m = axis * 3 + power;
                const moveStr = ("URFDLB".charAt(axis) + " 2'".charAt(power)).trim();

                CubieCube.CubeMult(this.prevCubie, CubieCube.moveCube[m], this.curCubie);
                computedFacelet = this.curCubie.toFaceCube();

                this.events$.next({
                    timestamp,
                    type: "MOVE",
                    face: axis,
                    direction: power === 0 ? 0 : 1,
                    move: moveStr,
                    localTimestamp: k === 0 ? timestamp : null,
                    cubeTimestamp: Math.trunc(moveTs / 1.6)
                });

                this.events$.next({
                    timestamp,
                    type: "FACELETS",
                    facelets: computedFacelet
                });

                const tmp = this.curCubie;
                this.curCubie = this.prevCubie;
                this.prevCubie = tmp;
            }

            // Every state-change packet also carries the cube's authoritative
            // facelets. Reconcile with them so a notification gap cannot leave
            // the virtual cube permanently out of sync.
            const authoritativeFacelet = parseFacelet(msg.slice(7, 34));
            if (authoritativeFacelet !== computedFacelet) {
                this.curCubie.fromFacelet(authoritativeFacelet);
                this.events$.next({
                    timestamp,
                    type: "FACELETS",
                    facelets: authoritativeFacelet
                });
                const tmp = this.curCubie;
                this.curCubie = this.prevCubie;
                this.prevCubie = tmp;
            }

            this.emitBatteryLevel(msg[35]!, timestamp);
        }

        this.lastTs = ts;
    }

    private onDisconnect = (): void => {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.lastBatteryLevel = null;
        this.forceNextBatteryEmission = false;
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
        if (!this.rawMessages$.closed) {
            this.rawMessages$.complete();
        }
    };

    async init(): Promise<void> {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
        const gatt = await this.device.gatt!.connect();
        const service = await gatt.getPrimaryService(SERVICE_UUID);
        const chrcts = await service.getCharacteristics();
        this.cubeChrct = findCharacteristic(chrcts, CHRCT_UUID_CUBE);

        if (!this.cubeChrct) {
            throw new Error('[QiYi] Cannot find required characteristic');
        }

        this.cubeChrct.addEventListener('characteristicvaluechanged', this.onCubeEvent);
        await this.cubeChrct.startNotifications();
        await this.sendHello();
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (command.type === "REQUEST_FACELETS" || command.type === "REQUEST_BATTERY") {
            if (command.type === "REQUEST_BATTERY") {
                this.forceNextBatteryEmission = true;
            }
            await this.sendHello();
        } else if (command.type === "REQUEST_HARDWARE") {
            this.emitHardwareEvent();
        }
    }

    async disconnect(): Promise<void> {
        if (this.cubeChrct) {
            this.cubeChrct.removeEventListener('characteristicvaluechanged', this.onCubeEvent);
            await this.cubeChrct.stopNotifications().catch(() => {});
            this.cubeChrct = null;
        }
        this.lastBatteryLevel = null;
        this.forceNextBatteryEmission = false;
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
}

function parseQiYiMacFromMf(mfData: BluetoothManufacturerData | DataView | null): string | null {
    if (!mfData) {
        return null;
    }
    return extractMacFromManufacturerData(mfData, QIYI_CIC_LIST, true);
}

async function connectQiYiDevice(
    device: BluetoothDevice,
    macProvider?: MacAddressProvider,
    context?: AttachmentContext
): Promise<SmartCubeConnection> {
    let mac = parseQiYiMacFromMf(context?.advertisementManufacturerData ?? null);
    mac = mac || getCachedMacForDevice(device);
    if (!mac && macProvider) {
        const r = await macProvider(device, false);
        if (r) {
            mac = r;
        }
    }

    if (!mac) {
        const mfData = await waitForAdvertisements(device, context?.enableAddressSearch ? 8000 : 5000);
        mac = parseQiYiMacFromMf(mfData);
    }

    if (!mac) {
        const c = buildQiYiMacCandidatesFromName(device.name);
        if (c.length === 1) {
            mac = c[0]!;
        }
    }

    if (!mac && context?.enableAddressSearch) {
        const candidates = buildQiYiMacCandidatesFromName(device.name);
        const timeoutMs = 3000;
        for (let i = 0; i < candidates.length; i++) {
            if (context.signal?.aborted) {
                break;
            }
            context.onStatus?.(`Testing address (${i + 1}/${candidates.length})…`);
            try {
                if (
                    await probeQiYiMac(device, candidates[i]!, {
                        timeoutMs,
                        signal: context.signal,
                    })
                ) {
                    mac = candidates[i]!;
                    break;
                }
            } catch {
                /* try next */
            }
        }
    }

    if (!mac && macProvider) {
        const r = await macProvider(device, true);
        if (r) {
            mac = r;
        }
    }

    if (!mac) {
        throw new Error('Unable to determine QiYi cube MAC address');
    }

    const conn = new QiYiConnection(device, mac);
    await conn.init();
    return conn;
}

const qiyiProtocol: SmartCubeProtocol = {
    nameFilters: [
        { namePrefix: "QY-QYSC" },
        { namePrefix: "XMD-TornadoV4-i" }
    ],
    optionalServices: [SERVICE_UUID],
    optionalManufacturerData: QIYI_CIC_LIST,

    matchesDevice(device: BluetoothDevice): boolean {
        const name = device.name || '';
        return name.startsWith('QY-QYSC') || name.startsWith('XMD-TornadoV4-i');
    },

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        return serviceUuids.has(normalizeUuid(SERVICE_UUID)) ? 110 : 0;
    },

    connect: connectQiYiDevice
};

registerProtocol(qiyiProtocol);

export { qiyiProtocol };
