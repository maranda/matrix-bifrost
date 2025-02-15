/**
 * A collection of interfaces that may be emitted by PurpleInterface
 */

import { IBifrostAccount } from "./Account";
import { IBasicProtocolMessage } from "../MessageFormatter";
import { IPublicRoomsResponse } from "../MatrixTypes";
import { WeakEvent } from "matrix-appservice-bridge";

export interface IChatJoinProperties {[key: string]: string; }

export interface IEventBody {
    eventName: string;
}

export interface IAccountMinimal {
    protocol_id: string;
    username: string;
}

export interface IConversationMinimal {
    name: string;
}

export interface IAccountEvent extends IEventBody {
    account: any|IAccountMinimal;
}

export interface IConversationEvent extends IAccountEvent {
    conv: any | IConversationMinimal;
}

// received-im-msg
export interface IReceivedImMsg extends IConversationEvent {
    sender: string;
    message: IBasicProtocolMessage;
}

export interface IFetchReceivedGroupMsg {
    room_id: string;
    event: WeakEvent;
}

export interface IChatInvite extends IAccountEvent {
    sender: string;
    message: string;
    room_name: string;
    join_properties: IChatJoinProperties;
}

export interface IChatJoined extends IConversationEvent {
    purpleAccount: IBifrostAccount;
    join_properties: IChatJoinProperties;
    should_invite: boolean;
}

export interface IUserStateChanged extends IConversationEvent {
    sender: string;
    state: "joined"|"left"|"kick";
    banner: string|boolean|undefined;
    kicker: string|boolean|undefined;
    technical: boolean|undefined;
    reason?: string;
    gatewayAlias: string|null;
    id: string;
}

export interface IChatTopicState extends IConversationEvent {
    sender: string;
    topic: string;
}

export interface IChatAvatarState extends IConversationEvent {
    sender: string;
    buffer: Buffer;
}

export interface IUserInfo extends IAccountEvent {
    [key: string]: string|IAccountMinimal|undefined;
    who: string;
}

export interface IChatTyping extends IConversationEvent {
    sender: string;
    typing: boolean;
}

export interface IChatReadReceipt extends IConversationEvent {
    sender: string;
    messageId: string;
    originIsMatrix: boolean;
}

export interface IGatewayRequest {
    roomAlias: string;
    result: (err: Error|null, res?: any) => void;
}

export interface IGatewayRoomQuery extends IGatewayRequest {
    result: (err: Error|null, res?: any) => void;
}

export interface IGatewayPublicRoomsQuery extends IGatewayRequest {
    onlyCheck: boolean;
    searchString: string;
    homeserver: string|null;
    result: (err: Error|null, res?: IPublicRoomsResponse) => void;
}

export interface IGatewayJoin {
    sender: string;
    protocol_id: string;
    join_id: string;
    nick: string;
    roomAlias: string;
    room_name: string;
}

export interface IStoreRemoteUser {
    mxId: string;
    remoteId: string;
    protocol_id: string;
    data?: any;
}
