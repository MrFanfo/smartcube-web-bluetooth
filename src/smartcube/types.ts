
import { Observable } from 'rxjs';

type PuzzleFamily = "3x3" | "2x2";

type SmartCubeMoveEvent = {
    type: "MOVE";
    puzzle?: PuzzleFamily;
    face: number;
    direction: number;
    move: string;
    serial?: number;
    recovered?: boolean;
    localTimestamp: number | null;
    cubeTimestamp: number | null;
    facelets24?: string;
    state2x2?: {
        cornerPermutation: number[];
        cornerOrientation: number[];
    };
};

type SmartCubeFaceletsEvent = {
    type: "FACELETS";
    puzzle?: PuzzleFamily;
    facelets: string;
    facelets24?: string;
    serial?: number;
    state2x2?: {
        cornerPermutation: number[];
        cornerOrientation: number[];
    };
};

type SmartCubeGyroEvent = {
    type: "GYRO";
    quaternion: { x: number; y: number; z: number; w: number };
    velocity?: { x: number; y: number; z: number };
};

type SmartCubeBatteryEvent = {
    type: "BATTERY";
    batteryLevel: number;
};

type SmartCubeProtocolInfo = {
    id: string;
    name: string;
    puzzleFamily: PuzzleFamily;
    serviceUuid?: string;
    gan251NameMatched?: boolean;
};

type SmartCubeHardwareEvent = {
    type: "HARDWARE";
    hardwareName?: string;
    softwareVersion?: string;
    hardwareVersion?: string;
    productDate?: string;
    gyroSupported?: boolean;
};

type SmartCubeDisconnectEvent = {
    type: "DISCONNECT";
};

type SmartCubeRawMessage = {
    /** Host-clock timestamp (ms) when the BLE notification was received. */
    timestamp: number;
    /** UUID of the GATT characteristic this packet arrived on. */
    characteristicUuid: string;
    /** Bytes exactly as received from the BLE layer (encrypted if the protocol uses encryption). */
    raw: Uint8Array;
    /** Bytes after decryption. null when decryption failed or the protocol transmits plaintext. */
    decrypted: Uint8Array | null;
    decryptionStatus?: "not-required" | "succeeded" | "failed";
    validationStatus?: "not-run" | "passed" | "failed";
    dropReason?: string;
    emittedEventCount?: number;
    emittedMoveCount?: number;
    rawNotificationCount?: number;
    decryptedPacketCount?: number;
    validatedPacketCount?: number;
    droppedValidationCount?: number;
};

type SmartCubeEventMessage =
    | SmartCubeMoveEvent
    | SmartCubeFaceletsEvent
    | SmartCubeGyroEvent
    | SmartCubeBatteryEvent
    | SmartCubeHardwareEvent
    | SmartCubeDisconnectEvent;

type SmartCubeEvent = { timestamp: number } & SmartCubeEventMessage;

type SmartCubeCommand =
    | { type: "REQUEST_FACELETS" }
    | { type: "REQUEST_BATTERY" }
    | { type: "REQUEST_HARDWARE" }
    | { type: "REQUEST_RESET" };

interface SmartCubeCapabilities {
    gyroscope: boolean;
    battery: boolean;
    facelets: boolean;
    hardware: boolean;
    reset: boolean;
}

interface SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo;
    readonly capabilities: SmartCubeCapabilities;
    events$: Observable<SmartCubeEvent>;
    /** Raw BLE packets for troubleshooting — emits every notification received from the cube. */
    rawMessages$: Observable<SmartCubeRawMessage>;
    sendCommand(command: SmartCubeCommand): Promise<void>;
    disconnect(): Promise<void>;
}

type MacAddressProvider = (device: BluetoothDevice, isFallbackCall?: boolean) => Promise<string | null>;

export type {
    PuzzleFamily,
    SmartCubeEvent,
    SmartCubeEventMessage,
    SmartCubeMoveEvent,
    SmartCubeFaceletsEvent,
    SmartCubeGyroEvent,
    SmartCubeBatteryEvent,
    SmartCubeProtocolInfo,
    SmartCubeHardwareEvent,
    SmartCubeDisconnectEvent,
    SmartCubeCommand,
    SmartCubeCapabilities,
    SmartCubeConnection,
    SmartCubeRawMessage,
    MacAddressProvider
};
