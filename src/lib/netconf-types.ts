/**
 * Default time in milliseconds the client waits for the server, used when `NetconfParams.timeout`
 * is not provided.
 */
export const SSH_TIMEOUT = 20000;

/**
 * Choice of what to request from the server
 */
export enum GetDataResultType {
  /**
   * Request the configuration data
   */
  CONFIG = 'config',
  /**
   * Request the state data
   */
  STATE = 'state',
  /**
   * Request schema (configuration data with only keys present in the result)
   */
  SCHEMA = 'schema',
}

export interface NamespaceType {
  alias: string;
  uri: string;
}

/**
 * Netconf client parameters
 */
export interface NetconfParams {
  /**
   * The host name or IP address of the Netconf server.
   */
  host: string;
  /**
   * The port number of the Netconf server.
   */
  port: number;
  /**
   * Netconf username.
   */
  user: string;
  /**
   * Netconf password. Can be omitted when `privateKey` or `agent` authentication is used.
   */
  pass?: string;
  /**
   * Private key for public key authentication. This is the content of the key file, not its path.
   * Set `passphrase` as well if the key is encrypted.
   */
  privateKey?: Buffer | string;
  /**
   * Passphrase that decrypts an encrypted `privateKey`.
   */
  passphrase?: string;
  /**
   * Path to the socket of a running ssh agent, usually the value of the SSH_AUTH_SOCK
   * environment variable.
   */
  agent?: string;
  /**
   * Time in milliseconds the client waits for the server: to accept the ssh connection, to open the
   * netconf channel, to send its hello, to reply to a request and to close the session. It does not
   * limit how long a subscription waits for notifications. Defaults to `SSH_TIMEOUT`.
   */
  timeout?: number;
  /**
   * Do not include namespaces in the result.
   * All namespaces, as well as other data that comes in attributes in the result xml,
   * will be removed from the result.
   */
  ignoreAttrs?: boolean;
  /**
   * Read data from the server only, edit-config or other rpc exec operations will not be performed.
   */
  readOnly?: boolean;
  /**
   * Allow multiple edit operations, that is, edit-config operations on multiple branches matching the XPath/Schema.
   * By default, it throws an error if XPath matches multiple branches when sending edit-config.
   */
  allowMultipleEdit?: boolean;
  /**
   * Target namespace to add to the request or list of namespaces with their aliases.
   */
  namespace?: string | (string | NamespaceType)[];
  /**
   * A function that receives a string argument and a level to print debug info.
   * The level is a number that indicates the verbosity of the provided debug message, 3 being the most verbose.
   */
  debug?: (message: string, level: number) => void;
}

export type NetconfConnectionState = 'uninitialized' | 'connecting' | 'ready' | 'closed';

export type NetconfPrimitiveType = string | number | boolean;
/**
 * Netconf object (XML parsed into a Javascript object that can have nested objects and arrays)
 */
export interface NetconfType {
  [key: string]: NetconfPrimitiveType | NetconfPrimitiveType[] | NetconfType | NetconfType[] | undefined | null;
}
/**
 * Hello message returned by the server
 */
export interface HelloType extends NetconfType {
  hello: {
    $?: {
      xmlns: string;
    };
    'session-id': number;
    capabilities: {
      capability: string[];
    };
  };
}

/**
 * ConfD error message
 */
export interface RpcErrorType extends NetconfType {
  'error-type': string;
  'error-tag': string;
  'error-severity': string;
  'error-message'?: {
    _: string;
  } | string;
  'error-info': {
    'bad-element'?: string;
    'bad-namespace'?: string;
    'bad-version'?: string;
    'bad-yang-version'?: string;
    'bad-content'?: string;
  };
  'error-path'?: {
    _: string;
  };
}

/**
 * ConfD response to any RPC request
 */
export interface RpcReplyType extends NetconfType {
  $?: {
    xmlns: string;
    'message-id': number;
  };
  ok?: string;
  'rpc-error'?: RpcErrorType;
  data?: NetconfType;
}

/**
 * Netconf notifications
 */
export interface NotificationType extends NetconfType {
  notification?: {
    $?: {
      xmlns: string;
    };
    [key: string]: NetconfType | undefined;
  };
}

/**
 * Netconf Library result, contains the server response in XML and the parsed result
 */
export interface Result {
  xml: string;
  result?: NetconfType;
}

/**
 * Hello message result
 */
export interface HelloResult extends Result {
  result: HelloType;
}

/**
 * Rpc result
 */
export interface RpcResult extends Result {
  result?: RpcReplyType;
}

/**
 * Rpc reply
 */
export interface RpcReply extends Result {
  result?: {
    'rpc-reply': RpcReplyType;
  };
}

/**
 * Get data result
 */
export type GetDataResult = Result;

/**
 * Edit config result
 */
export interface EditConfigResult extends Result {
  result?: RpcReplyType;
}

/**
 * Notification
 */
export interface NotificationResult extends Result {
  result: NotificationType;
}

/**
 * Subscription argument - XPath or stream name
 */
export type SubscriptionOption = {
  xpath: string;
} | {
  stream: string;
};

export interface CreateSubscriptionRequest extends NetconfType {
  'create-subscription': ({
    $?: {
      xmlns?: string;
    };
    filter: {
      $: {
        type: string;
        select: string;
      };
    };
  } | {
    $?: {
      xmlns?: string;
    };
    stream: string;
  });
}

/**
 * Custom error class for Netconf operations
 */
export class MultipleEditError extends Error {
  public constructor() {
    super('Editing multiple schema branches not allowed');
    this.name = 'MultipleEditError';
    Object.setPrototypeOf(this, MultipleEditError.prototype);
  }
}


// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SafeAny = any;
