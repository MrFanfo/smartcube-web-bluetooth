import { GanGen2CubeEncrypter } from './gan-cube-encrypter';
import type { GanCubeEvent, GanProtocolDriver } from './gan-cube-protocol';
import type { SmartCubeCapabilities, SmartCubeProtocolInfo } from './smartcube/types';
import { now } from './utils';

export type Gan251Face = 'U' | 'R' | 'F' | 'D' | 'L' | 'B';
type Gan251MoveDirection = 'clockwise' | 'counterclockwise' | 'double' | 'unknown';

const GAN251_BASE_KEY = new Uint8Array([
    0x58, 0x98, 0x61, 0xfc, 0x1f, 0xec, 0xd7, 0x60,
    0x9f, 0x85, 0xd3, 0x62, 0xbe, 0x37, 0x17, 0x2c,
]);

const GAN251_BASE_IV = new Uint8Array([
    0x7f, 0x61, 0xd0, 0x52, 0x75, 0xc1, 0x39, 0x52,
    0x08, 0x2e, 0x54, 0x1d, 0x8a, 0x78, 0x63, 0x4d,
]);

export const GAN251_PROTOCOL: SmartCubeProtocolInfo = {
    id: 'gan251-ui-v3-2',
    name: 'GAN251 UI V3-2',
};

export const GAN251_CAPABILITIES: SmartCubeCapabilities = {
    gyroscope: false,
    battery: true,
    facelets: true,
    hardware: false,
    reset: false,
};

const FACE_ORDER: Gan251Face[] = ['U', 'R', 'F', 'D', 'L', 'B'];
const FACE_MASK_TO_FACE: Record<number, Gan251Face> = {
    0x02: 'U',
    0x20: 'R',
    0x08: 'F',
    0x01: 'D',
    0x10: 'L',
    0x04: 'B',
};
const HISTORY_FACE_CODES = [1, 5, 3, 0, 4, 2];

export function isGan251DeviceName(deviceName: string | null | undefined): boolean {
    const name = (deviceName ?? '').trim().toLowerCase();
    return name.startsWith('gan251ui_') || name.startsWith('ganic251_');
}

export class Gan251CubeEncrypter extends GanGen2CubeEncrypter {
    constructor(salt: Uint8Array) {
        super(GAN251_BASE_KEY, GAN251_BASE_IV, salt);
    }
}

function bytesToHex(bytes: Uint8Array | number[]): string {
    return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(' ');
}

function trimTrailingZeros(bytes: Uint8Array): Uint8Array {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return end === bytes.length ? bytes : bytes.slice(0, end);
}

function crc16CcittFalse(bytes: Uint8Array): number {
    let crc = 0xffff;
    for (const byte of bytes) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
            crc &= 0xffff;
        }
    }
    return crc & 0xffff;
}

function validateCrc16(bytes: Uint8Array): boolean | null {
    if (bytes.length < 3) return null;
    const body = bytes.slice(0, -2);
    const expected = bytes[bytes.length - 2]! | (bytes[bytes.length - 1]! << 8);
    return crc16CcittFalse(body) === expected;
}

export function isValidGan251Packet(packet: Uint8Array | number[]): boolean {
    const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
    const decoded = decodeGan251Packet(bytes);
    return decoded.kind !== 'invalid' && decoded.crcValid !== false;
}

class MsbBitReader {
    constructor(private readonly bytes: Uint8Array) {}

    read(offset: number, length: number): number {
        let value = 0;
        for (let i = 0; i < length; i++) {
            const bitOffset = offset + i;
            const byte = this.bytes[Math.floor(bitOffset / 8)] ?? 0;
            const bit = (byte >> (7 - (bitOffset % 8))) & 1;
            value = (value << 1) | bit;
        }
        return value;
    }
}

function le16(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function le32(bytes: Uint8Array, offset: number): number {
    return (
        (bytes[offset] ?? 0) |
        ((bytes[offset + 1] ?? 0) << 8) |
        ((bytes[offset + 2] ?? 0) << 16) |
        ((bytes[offset + 3] ?? 0) << 24)
    ) >>> 0;
}

function decodeMoveByte(rawMoveByte: number): {
    face: Gan251Face | null;
    direction: Gan251MoveDirection;
    notation: string | null;
} {
    const face = FACE_MASK_TO_FACE[rawMoveByte & 0x3f] ?? null;
    const turnBits = (rawMoveByte >> 6) & 0x03;
    let direction: Gan251MoveDirection = 'unknown';
    if (face) {
        if (turnBits === 0) direction = 'clockwise';
        else if (turnBits === 1) direction = 'counterclockwise';
        else if (turnBits === 2) direction = 'double';
    }
    const suffix =
        direction === 'counterclockwise' ? "'"
            : direction === 'double' ? '2'
                : direction === 'clockwise' ? ''
                    : '';
    return { face, direction, notation: face && direction !== 'unknown' ? `${face}${suffix}` : null };
}

type Gan251MovePacket = {
    kind: 'move';
    crcValid: boolean | null;
    step: number;
    cubeTimestamp: number;
    face: Gan251Face | null;
    direction: Gan251MoveDirection;
    notation: string | null;
};

type Gan251StatePacket = {
    kind: 'state';
    crcValid: boolean | null;
    step: number;
    cornerPermutation: number[];
    cornerOrientation: number[];
    facelets24: string;
};

type Gan251HistoryMove = {
    serial: number;
    face: Gan251Face;
    direction: Gan251MoveDirection;
    notation: string;
};

type Gan251HistoryPacket = {
    kind: 'history';
    crcValid: boolean | null;
    moves: Gan251HistoryMove[];
};

type Gan251BatteryPacket = {
    kind: 'battery';
    crcValid: boolean | null;
    batteryLevel: number;
};

type Gan251Packet =
    | Gan251MovePacket
    | Gan251StatePacket
    | Gan251HistoryPacket
    | Gan251BatteryPacket
    | { kind: 'other'; crcValid: boolean | null; packetId: number }
    | { kind: 'invalid'; crcValid: false; reason: string };

function inferMissingCorner(firstSeven: number[]): number {
    const used = new Set(firstSeven);
    for (let value = 0; value < 8; value++) {
        if (!used.has(value)) return value;
    }
    return 7;
}

function hasValidCorners(cp: number[], co: number[]): boolean {
    const sorted = [...cp].sort((a, b) => a - b);
    return (
        cp.length === 8 &&
        sorted.every((value, index) => value === index) &&
        co.length === 8 &&
        co.every((value) => Number.isInteger(value) && value >= 0 && value <= 2)
    );
}

function decodeGan251Packet(input: Uint8Array): Gan251Packet {
    const candidates = [trimTrailingZeros(input), input];
    let fallback: Gan251Packet | null = null;
    for (const decrypted of candidates) {
        const decoded = decodeGan251PacketCandidate(decrypted);
        if (decoded.kind !== 'invalid' && decoded.crcValid !== false) return decoded;
        fallback ??= decoded;
    }
    return fallback ?? { kind: 'invalid', crcValid: false, reason: 'empty packet' };
}

function decodeGan251PacketCandidate(decrypted: Uint8Array): Gan251Packet {
    if (decrypted.length < 1) {
        return { kind: 'invalid', crcValid: false, reason: 'empty packet' };
    }
    const packetId = decrypted[0]!;
    const crcValid = validateCrc16(decrypted);

    if (packetId === 0x01) {
        if (decrypted.length < 11) {
            return { kind: 'invalid', crcValid: false, reason: 'move packet too short' };
        }
        const move = decodeMoveByte(decrypted[8]!);
        return {
            kind: 'move',
            crcValid,
            step: le16(decrypted, 6),
            cubeTimestamp: le32(decrypted, 2),
            face: move.face,
            direction: move.direction,
            notation: move.notation,
        };
    }

    if (packetId === 0xed) {
        if (decrypted.length < 18) {
            return { kind: 'invalid', crcValid: false, reason: 'state packet too short' };
        }
        const dataLength = decrypted[1] ?? 0;
        const dataEnd = Math.min(2 + dataLength, decrypted.length - 2);
        const reader = new MsbBitReader(decrypted.slice(4, dataEnd));
        const firstSeven = Array.from({ length: 7 }, (_, index) => reader.read(index * 3, 3));
        const cp = [...firstSeven, inferMissingCorner(firstSeven)];
        const co = Array.from({ length: 8 }, (_, index) => reader.read(21 + index * 2, 2) % 3);
        if (!hasValidCorners(cp, co)) {
            return { kind: 'invalid', crcValid: false, reason: `invalid corner state cp=${cp.join(',')} co=${co.join(',')}` };
        }
        const cube = new Virtual2x2Cube(cp, co);
        return {
            kind: 'state',
            crcValid,
            step: le16(decrypted, 2),
            cornerPermutation: cp,
            cornerOrientation: co,
            facelets24: cube.toFacelets24(),
        };
    }

    if (packetId === 0xd1) {
        if (decrypted.length < 3) {
            return { kind: 'invalid', crcValid: false, reason: 'history packet too short' };
        }
        const reader = new MsbBitReader(decrypted);
        const dataLength = decrypted[1] ?? 0;
        const startSerial = reader.read(16, 8);
        const count = Math.max(0, (dataLength - 1) * 2);
        const moves: Gan251HistoryMove[] = [];
        for (let i = 0; i < count; i++) {
            if (24 + 4 * i + 4 > decrypted.length * 8) break;
            const faceCode = reader.read(24 + 4 * i, 3);
            const directionBit = reader.read(27 + 4 * i, 1);
            const faceIndex = HISTORY_FACE_CODES.indexOf(faceCode);
            if (faceIndex < 0) continue;
            const face = FACE_ORDER[faceIndex]!;
            const direction: Gan251MoveDirection = directionBit === 1 ? 'counterclockwise' : 'clockwise';
            moves.push({
                serial: (startSerial - i) & 0xff,
                face,
                direction,
                notation: `${face}${direction === 'counterclockwise' ? "'" : ''}`,
            });
        }
        return { kind: 'history', crcValid, moves };
    }

    if (packetId === 0xef) {
        const batteryLevel = decrypted.length > 2 ? decrypted[decrypted.length - 3]! : 0;
        return { kind: 'battery', crcValid, batteryLevel: Math.min(100, Math.max(0, batteryLevel)) };
    }

    return { kind: 'other', crcValid, packetId };
}

type StickerRef = { face: Gan251Face; index: number };
const SOLVED_CP = [0, 1, 2, 3, 4, 5, 6, 7] as const;
const SOLVED_CO = [0, 0, 0, 0, 0, 0, 0, 0] as const;
const CORNER_COLORS: Record<number, [Gan251Face, Gan251Face, Gan251Face]> = {
    0: ['U', 'R', 'F'],
    1: ['U', 'F', 'L'],
    2: ['U', 'L', 'B'],
    3: ['U', 'B', 'R'],
    4: ['D', 'F', 'R'],
    5: ['D', 'L', 'F'],
    6: ['D', 'B', 'L'],
    7: ['D', 'R', 'B'],
};
const CORNER_STICKERS: Record<number, [StickerRef, StickerRef, StickerRef]> = {
    0: [{ face: 'U', index: 3 }, { face: 'R', index: 0 }, { face: 'F', index: 1 }],
    1: [{ face: 'U', index: 2 }, { face: 'F', index: 0 }, { face: 'L', index: 1 }],
    2: [{ face: 'U', index: 0 }, { face: 'L', index: 0 }, { face: 'B', index: 1 }],
    3: [{ face: 'U', index: 1 }, { face: 'B', index: 0 }, { face: 'R', index: 1 }],
    4: [{ face: 'D', index: 1 }, { face: 'F', index: 3 }, { face: 'R', index: 2 }],
    5: [{ face: 'D', index: 0 }, { face: 'L', index: 3 }, { face: 'F', index: 2 }],
    6: [{ face: 'D', index: 2 }, { face: 'B', index: 3 }, { face: 'L', index: 2 }],
    7: [{ face: 'D', index: 3 }, { face: 'R', index: 3 }, { face: 'B', index: 2 }],
};
const MOVE_DEFS: Record<Gan251Face, { cycle: [number, number, number, number]; coDelta: [number, number, number, number] }> = {
    U: { cycle: [0, 1, 2, 3], coDelta: [0, 0, 0, 0] },
    R: { cycle: [0, 3, 7, 4], coDelta: [2, 1, 2, 1] },
    F: { cycle: [0, 4, 5, 1], coDelta: [1, 2, 1, 2] },
    D: { cycle: [4, 7, 6, 5], coDelta: [0, 0, 0, 0] },
    L: { cycle: [1, 5, 6, 2], coDelta: [1, 2, 1, 2] },
    B: { cycle: [2, 6, 7, 3], coDelta: [1, 2, 1, 2] },
};

class Virtual2x2Cube {
    private cp: number[];
    private co: number[];

    constructor(cp: number[] = [...SOLVED_CP], co: number[] = [...SOLVED_CO]) {
        this.cp = [...cp];
        this.co = [...co];
    }

    reset(): void {
        this.cp = [...SOLVED_CP];
        this.co = [...SOLVED_CO];
    }

    loadCorners(cp: number[], co: number[]): void {
        this.cp = [...cp];
        this.co = [...co];
    }

    applyMove(face: Gan251Face, direction: Gan251MoveDirection): void {
        const turns = direction === 'clockwise' ? 1 : direction === 'double' ? 2 : direction === 'counterclockwise' ? 3 : 0;
        for (let i = 0; i < turns; i++) this.applyClockwiseFace(face);
    }

    getCornerPermutation(): number[] {
        return [...this.cp];
    }

    getCornerOrientation(): number[] {
        return [...this.co];
    }

    toFacelets24(): string {
        const faces = Object.fromEntries(FACE_ORDER.map((face) => [face, [face, face, face, face]])) as Record<Gan251Face, string[]>;
        for (let position = 0; position < 8; position++) {
            const cubie = this.cp[position]!;
            const orientation = this.co[position]! % 3;
            const colors = CORNER_COLORS[cubie]!;
            const stickers = CORNER_STICKERS[position]!;
            for (let stickerIndex = 0; stickerIndex < 3; stickerIndex++) {
                const color = colors[(stickerIndex + 3 - orientation) % 3]!;
                const target = stickers[stickerIndex]!;
                faces[target.face][target.index] = color;
            }
        }
        return FACE_ORDER.map((face) => faces[face].join('')).join('');
    }

    private applyClockwiseFace(face: Gan251Face): void {
        const def = MOVE_DEFS[face];
        const oldCp = [...this.cp];
        const oldCo = [...this.co];
        const [a, b, c, d] = def.cycle;
        this.cp[a] = oldCp[d]!;
        this.cp[b] = oldCp[a]!;
        this.cp[c] = oldCp[b]!;
        this.cp[d] = oldCp[c]!;
        this.co[a] = (oldCo[d]! + def.coDelta[0]) % 3;
        this.co[b] = (oldCo[a]! + def.coDelta[1]) % 3;
        this.co[c] = (oldCo[b]! + def.coDelta[2]) % 3;
        this.co[d] = (oldCo[c]! + def.coDelta[3]) % 3;
    }
}

type RecoveredMove = {
    serial: number;
    face: Gan251Face;
    direction: Gan251MoveDirection;
    cubeTimestamp: number | null;
    localTimestamp: number | null;
};

class Gan251MoveRecovery {
    private serial = -1;
    private lastSerial = -1;
    private lastLocalTimestamp: number | null = null;
    private moveBuffer: RecoveredMove[] = [];

    constructor(
        private readonly requestHistory: (serial: number, count: number) => void,
        private readonly emitMove: (move: RecoveredMove) => void,
    ) {}

    ingestMove(serial: number, face: Gan251Face, direction: Gan251MoveDirection, cubeTimestamp: number | null, timestamp: number): void {
        if (this.lastSerial === -1) this.lastSerial = (serial - 1) & 0xff;
        this.serial = serial & 0xff;
        this.lastLocalTimestamp = timestamp;
        this.moveBuffer.push({ serial: serial & 0xff, face, direction, cubeTimestamp, localTimestamp: timestamp });
        this.evictMoveBuffer();
    }

    ingestState(serial: number, timestamp: number): void {
        this.serial = serial & 0xff;
        if (this.lastSerial !== -1 && this.lastLocalTimestamp != null && timestamp - this.lastLocalTimestamp > 500) {
            this.checkIfMoveMissed();
        }
        if (this.lastSerial === -1) this.lastSerial = serial & 0xff;
    }

    ingestHistory(moves: Gan251HistoryMove[]): void {
        for (const move of moves) {
            this.injectMissedMoveToBuffer({
                serial: move.serial & 0xff,
                face: move.face,
                direction: move.direction,
                cubeTimestamp: null,
                localTimestamp: null,
            });
        }
        this.evictMoveBuffer();
    }

    private evictMoveBuffer(): void {
        while (this.moveBuffer.length > 0) {
            const head = this.moveBuffer[0]!;
            const diff = this.lastSerial === -1 ? 1 : (head.serial - this.lastSerial) & 0xff;
            if (diff > 1) {
                this.requestMoveHistory(head.serial, diff);
                break;
            }
            this.moveBuffer.shift();
            this.lastSerial = head.serial;
            this.emitMove(head);
        }
    }

    private checkIfMoveMissed(): void {
        const diff = (this.serial - this.lastSerial) & 0xff;
        if (diff > 0 && this.serial !== 0) {
            const head = this.moveBuffer[0];
            this.requestMoveHistory(head ? head.serial : (this.serial + 1) & 0xff, diff + 1);
        }
    }

    private requestMoveHistory(serial: number, count: number): void {
        if (serial % 2 === 0) serial = (serial - 1) & 0xff;
        if (count % 2 === 1) count++;
        count = Math.min(count, serial + 1);
        this.requestHistory(serial, count);
    }

    private isSerialInRange(start: number, end: number, serial: number, closedStart = false, closedEnd = false): boolean {
        return (
            ((end - start) & 0xff) >= ((serial - start) & 0xff) &&
            (closedStart || ((start - serial) & 0xff) > 0) &&
            (closedEnd || ((end - serial) & 0xff) > 0)
        );
    }

    private injectMissedMoveToBuffer(move: RecoveredMove): void {
        if (this.moveBuffer.length > 0) {
            const head = this.moveBuffer[0]!;
            if (this.moveBuffer.some((e) => e.serial === move.serial)) return;
            if (!this.isSerialInRange(this.lastSerial, head.serial, move.serial)) return;
            if (move.serial === ((head.serial - 1) & 0xff)) this.moveBuffer.unshift(move);
        } else if (this.isSerialInRange(this.lastSerial, this.serial, move.serial, false, true)) {
            this.moveBuffer.unshift(move);
        }
    }
}

type RawConnection = Parameters<GanProtocolDriver['handleStateEvent']>[0];

export class Gan251ProtocolDriver implements GanProtocolDriver {
    private readonly cube = new Virtual2x2Cube();
    private readonly recovery = new Gan251MoveRecovery(
        (serial, count) => {
            void this.conn?.sendCommandMessage(this.createHistoryCommand(serial, count)).catch(() => {});
        },
        (move) => this.emitRecoveredMove(move),
    );
    private conn: RawConnection | null = null;
    private pendingEvents: GanCubeEvent[] = [];

    createCommandMessage(command: { type: string }): Uint8Array | undefined {
        const msg = new Uint8Array(20).fill(0);
        switch (command.type) {
            case 'REQUEST_FACELETS':
                msg.set([0xdd, 0x04, 0x00, 0xed, 0x00, 0x00]);
                return msg;
            case 'REQUEST_BATTERY':
                msg.set([0xdd, 0x04, 0x00, 0xef, 0x00, 0x00]);
                return msg;
            default:
                return undefined;
        }
    }

    async handleStateEvent(conn: RawConnection, eventMessage: Uint8Array): Promise<GanCubeEvent[]> {
        this.conn = conn;
        this.pendingEvents = [];
        const timestamp = now();
        const decoded = decodeGan251Packet(eventMessage);

        if (decoded.kind === 'move' && decoded.face && decoded.direction !== 'unknown') {
            this.recovery.ingestMove(decoded.step, decoded.face, decoded.direction, decoded.cubeTimestamp, timestamp);
        } else if (decoded.kind === 'state') {
            this.cube.loadCorners(decoded.cornerPermutation, decoded.cornerOrientation);
            this.recovery.ingestState(decoded.step, timestamp);
            this.pendingEvents.push({
                type: 'FACELETS',
                timestamp,
                serial: decoded.step,
                puzzle: '2x2',
                facelets: decoded.facelets24,
                facelets24: decoded.facelets24,
                state2x2: {
                    cornerPermutation: decoded.cornerPermutation,
                    cornerOrientation: decoded.cornerOrientation,
                },
                state: {
                    CP: decoded.cornerPermutation,
                    CO: decoded.cornerOrientation,
                    EP: [],
                    EO: [],
                },
            } as GanCubeEvent);
        } else if (decoded.kind === 'history') {
            this.recovery.ingestHistory(decoded.moves);
        } else if (decoded.kind === 'battery') {
            this.pendingEvents.push({
                type: 'BATTERY',
                timestamp,
                batteryLevel: decoded.batteryLevel,
            });
        }

        return this.pendingEvents;
    }

    private createHistoryCommand(serial: number, count: number): Uint8Array {
        const msg = new Uint8Array(20).fill(0);
        msg.set([0xd1, 0x04, serial & 0xff, 0x00, count & 0xff, 0x00]);
        return msg;
    }

    private emitRecoveredMove(move: RecoveredMove): void {
        this.cube.applyMove(move.face, move.direction);
        const suffix = move.direction === 'counterclockwise' ? "'" : move.direction === 'double' ? '2' : '';
        const notation = `${move.face}${suffix}`;
        const timestamp = move.localTimestamp ?? now();
        this.pendingEvents.push({
            type: 'MOVE',
            timestamp,
            puzzle: '2x2',
            serial: move.serial,
            recovered: move.localTimestamp === null,
            face: FACE_ORDER.indexOf(move.face),
            direction: move.direction === 'counterclockwise' ? 1 : move.direction === 'double' ? 2 : 0,
            move: notation,
            localTimestamp: move.localTimestamp,
            cubeTimestamp: move.cubeTimestamp,
            facelets24: this.cube.toFacelets24(),
            state2x2: {
                cornerPermutation: this.cube.getCornerPermutation(),
                cornerOrientation: this.cube.getCornerOrientation(),
            },
        } as GanCubeEvent);
    }
}

export function summarizeGan251Bytes(bytes: Uint8Array): string {
    const decoded = decodeGan251Packet(bytes);
    if (decoded.kind === 'move') return `GAN251 move ${decoded.notation ?? '?'} step=${decoded.step}`;
    if (decoded.kind === 'state') return `GAN251 state ${decoded.facelets24}`;
    if (decoded.kind === 'history') return `GAN251 history ${decoded.moves.map((m) => m.notation).join(' ')}`;
    if (decoded.kind === 'battery') return `GAN251 battery ${decoded.batteryLevel}%`;
    if (decoded.kind === 'invalid') return `GAN251 invalid ${decoded.reason}`;
    return `GAN251 packet ${bytesToHex(bytes.slice(0, 4))}`;
}
