import { MatrixUser, Bridge, RoomBridgeStoreEntry } from "matrix-appservice-bridge";
import { IRemoteRoomData, IRemoteGroupData, MROOM_TYPES } from "./Types";
import { BifrostProtocol } from "../bifrost/Protocol";
import { IAccountMinimal } from "../bifrost/Events";
import { BifrostRemoteUser } from "./BifrostRemoteUser";
import { IConfigDatastore } from "../Config";
import { NeDBStore } from "./NeDBStore";
import { PgDataStore } from "./postgres/PgDatastore";

export async function initiateStore(config: IConfigDatastore, bridge: Bridge): Promise<IStore> {
    if (config.engine === "nedb") {
        return new NeDBStore(bridge);
    } else if (config.engine === "postgres") {
        const pg = new PgDataStore(config);
        await pg.ensureSchema();
        return pg;
    }
    throw Error("Database engine not supported");
}

export interface IStore {

    getMatrixUser(id: string): Promise<MatrixUser|null>;

    getMatrixUserForAccount(account: IAccountMinimal): Promise<MatrixUser|null>;

    setMatrixUser(matrix: MatrixUser): Promise<void>;

    getRemoteUserBySender(sender: string, protocol: BifrostProtocol): Promise<BifrostRemoteUser|null>;

    getAccountsForMatrixUser(userId: string, protocolId: string): Promise<BifrostRemoteUser[]>;

    getRemoteUsersFromMxId(userId: string): Promise<BifrostRemoteUser[]>;

    getGroupRoomByRemoteData(remoteData: IRemoteRoomData|IRemoteGroupData): Promise<RoomBridgeStoreEntry|null>;

    getAdminRoom(matrixUserId: string): Promise<string|null>;

    getIMRoom(matrixUserId: string, protocolId: string, remoteUserId: string): Promise<RoomBridgeStoreEntry|null>;

    getUsernameMxidForProtocol(protocol: BifrostProtocol): Promise<{[mxid: string]: string}>;

    getRoomsOfType(type: MROOM_TYPES): Promise<RoomBridgeStoreEntry[]>;

    listLocalSenderNames(): Promise<Set<string>>;

    storeGhost(userId: string, protocol: BifrostProtocol, username: string, extraData?: any)
    : Promise<{remote: BifrostRemoteUser, matrix: MatrixUser}>;
    storeAccount(userId: string, protocol: BifrostProtocol, username: string, extraData?: any): Promise<void>;
    removeGhost(userId: string, protocol: BifrostProtocol, username: string): Promise<void>;
    removeRoomByRoomId(matrixId: string): Promise<void>;

    getRoomEntryByMatrixId(roomId: string): Promise<RoomBridgeStoreEntry|null>;

    storeRoom(matrixId: string, type: MROOM_TYPES, remoteId: string, remoteData: IRemoteRoomData)
    : Promise<RoomBridgeStoreEntry>;

    getMatrixEventId(roomId: string, remoteEventId: string): Promise<string|null>;
    getRemoteEventId(roomId: string, matrixEventId: string): Promise<string | null>;
    getOriginIdFromEvent(roomId: string, matrixEventId: string): Promise<string | null>;
    getStanzaIdFromEvent(roomId: string, matrixEventId: string): Promise<string | null>;

    storeRoomEvent(roomId: string, matrixEventId: string, remoteEventId: string, remoteOriginId?: string, remoteStanzaId?: string): Promise<void>;

    integrityCheck(canWrite: boolean): Promise<void>;
}
