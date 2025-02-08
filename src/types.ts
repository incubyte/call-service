import { ClientMessageBase, ServerMessageBase } from "rt-client";

export interface FunctionCallParams {
    function_name: string;
    arguments: Record<string, any>;
}

export interface FunctionCallMessage extends ClientMessageBase {
    type: "function.call";
    function_call: FunctionCallParams;
}

export interface FunctionCallResponse {
    function_name: string;
    result: any;
}

export interface FunctionCallResponseMessage extends ServerMessageBase {
    type: "function.call.response";
    function_call_response: FunctionCallResponse;
}