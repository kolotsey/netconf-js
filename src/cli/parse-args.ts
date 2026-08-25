// import * as getoptsImport from 'getopts';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import * as getoptsImport from 'getopts';
import * as packageJson from '../../package.json' with { type: 'json' };
import { GetDataResultType, NamespaceType, NetconfDatastore, NetconfType, SafeAny, SSH_TIMEOUT } from '../lib/index.ts';
import { showHelp } from './help.ts';
import { Output } from './output.ts';
import { ConnArgs, parseConnStr } from './parse-conn-str.ts';

export const DEFAULT_USER = 'admin';
export const DEFAULT_PASS = 'admin';
export const DEFAULT_PORT = 2022;
export const DEFAULT_XPATH = '/';

const MS_IN_SECOND = 1000;

/** Default value of --timeout, in seconds */
export const DEFAULT_TIMEOUT = SSH_TIMEOUT / MS_IN_SECOND;

/**
 * Accepted spellings of the operation keyword. Every alias must be listed in full: the keyword is
 * matched against the whole argument, because matching a prefix turns a host name into an operation
 * (`subnet.example.com` starts with `sub`) and a mistyped keyword into a destructive one
 * (`deleteme` starts with `del`).
 */
const OPERATION_ALIASES = {
  get: 'get',
  upd: 'merge',
  update: 'merge',
  set: 'merge',
  mer: 'merge',
  merge: 'merge',
  add: 'create',
  cre: 'create',
  create: 'create',
  del: 'delete',
  delete: 'delete',
  rem: 'delete',
  remove: 'delete',
  rep: 'replace',
  replace: 'replace',
  sub: 'subscribe',
  subscribe: 'subscribe',
  rpc: 'rpc',
  exec: 'rpc',
  com: 'commit',
  commit: 'commit',
  dis: 'discard',
  discard: 'discard',
} as const;

export enum OperationType {
  /**
   * Print hello message and exit
   */
  HELLO = 'hello',
  /**
   * get-data operation
   */
  GET = 'get',
  /**
   * edit-config, nc:operation="merge"
   */
  MERGE = 'merge',
  /**
   * edit-config, nc:operation="create"
   */
  CREATE = 'create',
  /**
   * edit-config, nc:operation="delete"
   */
  DELETE = 'delete',
  /**
   * edit-config, nc:operation="replace"
   */
  REPLACE = 'replace',
  /**
   * subscribe to notifications
   */
  SUBSCRIBE = 'subscribe',
  /**
   * arbitrary rpc exec
   */
  RPC = 'rpc',
  /**
   * commit the candidate datastore
   */
  COMMIT = 'commit',
  /**
   * discard the changes collected in the candidate datastore
   */
  DISCARD = 'discard',
}

/**
 * Options for Get operation.
 */
type GetOptions = {
  /**
   * XPath filter to use for the operation
   */
  xpath: string;
  /**
   * Request only the configuration, state or schema. If not provided, all data will be requested.
   */
  configFilter?: GetDataResultType;
  /**
   * If true, print the full tree of the result.
   * If false, strip parent nodes to simplify the output
   */
  fullTree?: boolean;
  /**
   * Print namespaces in the result. Namespaces are sent by the server and stripped by default.
   */
  showNamespaces?: boolean;
};

/**
 * Options for edit-config with operation="merge".
 */
type MergeOptions = {
  /**
   * XPath filter to use for the operation.
   * If XPath is /config/interfaces/interface[name='GigabitEthernet1/0/1']
   * then the operation will be performed on the `interface` node.
   */
  xpath: string;
  /**
   * Key-value pairs to be merged into the set
   */
  values?: NetconfType;
  /**
   * Allow multiple schema branches to be edited in a single operation
   */
  allowMultiple?: boolean;
};

type EditConfigValues = {
  type: 'keyvalue';
  /**
   * Object of key-value pairs
   */
  values: NetconfType;
} | {
  type: 'list';
  /**
   * Array of values
   */
  values: string[];
};

/**
 * Options for edit-config with operation="create".
 */
type CreateOptions = {
  /**
   * XPath filter to use for the operation.
   * If XPath is /config/interfaces/interface[name='GigabitEthernet1/0/1']
   * then the `interface` node will be created with key name=GigabitEthernet1/0/1.
   */
  xpath: string;
  /**
   * Key-value pairs to be created in the set
   * or array of values to be added to the list
   */
  editConfigValues: EditConfigValues;
  /**
   * Key to insert the new object before
   */
  beforeKey?: string;
  /**
   * Allow multiple schema branches to be edited in a single operation
   */
  allowMultiple?: boolean;
};

/**
 * Options for edit-config with operation="delete".
 */
type DeleteOptions = {
  /**
   * XPath filter to use for the operation.
   * If XPath is /config/interfaces/interface[name='GigabitEthernet1/0/1']
   * then the `interface` node will be deleted.
   */
  xpath: string;
  /**
   * Key-value pairs to be deleted from the set
   * or array of values to be deleted from the list
   */
  editConfigValues: EditConfigValues;
  /**
   * Allow multiple schema branches to be edited in a single operation
   */
  allowMultiple?: boolean;
};

/**
 * Options for edit-config with operation="replace".
 */
type ReplaceOptions = {
  /**
   * XPath filter to use for the operation.
   */
  xpath: string;
  /**
   * Key-value pairs to be deleted from the set
   * or array of values to be deleted from the list
   */
  editConfigValues: EditConfigValues;
  /**
   * Allow multiple schema branches to be edited in a single operation
   */
  allowMultiple?: boolean;
};

/**
 * Options for subscription to notifications.
 */
type SubscribeOptions = {
  type: 'xpath';
  /**
   * XPath filter to use for the operation.
   */
  xpath: string;
} | {
  type: 'stream';
  /**
   * Notification stream to use for the operation, for example "netconf".
   */
  stream: string;
};

/**
 * Options for RPC operation.
 */
type RpcOptions = {
  /**
   * Command to execute.
   */
  cmd: string;
  /**
   * Key-value pairs to be added to the RPC request
   */
  values?: NetconfType;
};

type Operation =
  | { type: undefined }
  | { type: OperationType.HELLO }
  | { type: OperationType.GET, options: GetOptions }
  | { type: OperationType.MERGE, options: MergeOptions }
  | { type: OperationType.CREATE, options: CreateOptions }
  | { type: OperationType.DELETE, options: DeleteOptions }
  | { type: OperationType.REPLACE, options: ReplaceOptions }
  | { type: OperationType.SUBSCRIBE, options: SubscribeOptions }
  | { type: OperationType.RPC, options: RpcOptions }
  | { type: OperationType.COMMIT }
  | { type: OperationType.DISCARD };

export enum ResultFormat {
  JSON = 'json',
  XML = 'xml',
  YAML = 'yaml',
  /**
   * all data is printed in key=value format (nested keys are joined with a dot)
   */
  KEYVALUE = 'keyvalue',
  /**
   * all data is printed in tree format, useful for reviewing the data
   */
  TREE = 'tree',
}

export interface CliOptions {
  /**
   * Netconf host name or IP address
   */
  host: string;

  /**
   * Netconf port number
   */
  port: number;

  /**
   * Netconf username
   */
  user: string;

  /**
   * Netconf password. Undefined when public key or agent authentication is used and no password
   * was provided explicitly.
   */
  pass?: string;

  /**
   * Content of the private key file, for public key authentication
   */
  privateKey?: Buffer;

  /**
   * Passphrase that decrypts an encrypted private key
   */
  passphrase?: string;

  /**
   * Path to the socket of a running ssh agent
   */
  agent?: string;

  /**
   * Time in milliseconds to wait for the server
   */
  timeout?: number;

  /**
   * Datastore that edit-config writes to
   */
  datastore?: NetconfDatastore;

  /**
   * Commit the candidate datastore once the edit-config succeeded
   */
  autoCommit?: boolean;

  /**
   * Operation to be performed
   */
  operation: Operation;

  /**
   * YANG namespace to add to the request
   */
  namespaces?: (string | NamespaceType)[];

  /**
   * Print result in the specified format
   */
  resultFormat: ResultFormat;

  /**
   * Only read the data from the server, no edit-config or RPC operations
   */
  readOnly?: boolean;
}

/**
 * Parse command line arguments
 *
 * @returns If parsing was successful, an object with the parsed options is returned. In case when help or version
 *   options are provided, the function will return undefined and the program must exit with 0 (success) code.
 *   If parsing fails, the function will throw an error.
 */
// eslint-disable-next-line max-lines-per-function, sonarjs/cognitive-complexity
export async function parseArgs(): Promise<CliOptions | undefined> {
  let args = process.argv.slice(2);
  const getopts = (getoptsImport as SafeAny).default as unknown as typeof import('getopts');
  const opt = getopts(args, {
    alias: {
      allowmultiple: ['allow-multiple'],
      b: ['beforekey', 'before-key'],
      config: ['configonly', 'config-only'],
      f: ['fulltree', 'full-tree'],
      h: 'help',
      H: 'host',
      i: 'identity',
      j: 'json',
      k: ['keyvalue', 'key-value'],
      p: 'port',
      P: ['pass', 'password'],
      readonly: 'read-only',
      schema: ['schemaonly', 'schema-only'],
      s: ['shownamespaces', 'show-namespaces'],
      state: ['stateonly', 'state-only'],
      stdin: ['stdin'],
      U: 'user',
      v: 'version',
      V: 'verbose',
      x: 'xml',
      y: 'yaml',
    },
    default: {
      agent: false,
      allowmultiple: false,
      beforekey: undefined,
      candidate: false,
      commit: false,
      configonly: false,
      fulltree: false,
      host: undefined,
      identity: undefined,
      json: false,
      passphrase: undefined,
      keyvalue: false,
      namespace: undefined,
      pass: undefined,
      port: undefined,
      readonly: false,
      schemaonly: false,
      stateonly: false,
      stdin: false,
      timeout: undefined,
      user: undefined,
      shownamespaces: false,
      xml: false,
      yaml: false,
      hello: false,
    },
    // eslint-disable-next-line id-denylist
    boolean: [
      'agent', 'allowmultiple', 'candidate', 'commit', 'configonly', 'fulltree', 'help', 'json', 'keyvalue', 'read-only', 'schemaonly',
      'shownamespaces', 'stateonly', 'stdin', 'version', 'verbose', 'xml', 'yaml', 'hello',
    ],
    unknown: (optionName: string): boolean => {
      if(optionName.startsWith('xmlns')) {
        return true;
      }else{
        throw new Error(`Unknown option: ${optionName}`);
      }
    },
  });

  if (opt.help) {
    showHelp();
    return undefined;
  }

  if (opt.version) {
    console.info(packageJson.default.version);
    return undefined;
  }

  // Check verbose level. If it's an array, use the length, otherwise use 1 if it's true, 0 otherwise
  // Immediatly set the verbose level to the Output class.
  let verbose = 0;
  if (Array.isArray(opt.verbose)) {
    verbose = opt.verbose.length;
  } else {
    verbose = opt.verbose ? 1 : 0;
  }
  if (verbose > 0) {
    Output.verbosity = verbose;
    Output.debug(`Verbose output enabled, level ${verbose}`);
  }

  let xpath: string | undefined;
  let conn: string | undefined;
  let stream: string | undefined;
  let operationType: OperationType | undefined;
  const keyValuePairs: Record<string, string> = {};
  let listItems: string[] = [];

  // Parsing command line arguments and getting the requested XPath and credentials (if provided)
  args = opt._.filter(arg => arg !== '');
  while (args.length) {
    // Operation
    const op = args[0].toLowerCase();
    // hasOwn, not `in`: `in` also matches the inherited properties of Object (`constructor`, ...)
    if (Object.hasOwn(OPERATION_ALIASES, op)) {
      const normalizedOp = OPERATION_ALIASES[op as keyof typeof OPERATION_ALIASES];
      operationType = normalizedOp as OperationType;
      args.shift();

    // XPath
    } else if (args[0].substring(0, 1) === '/') {
      xpath = args.shift() as string;

    // Test if the argument is a list item
    } else if (args[0].startsWith('[')) {
      // list item
      if(listItems.length) {
        throw new Error('List items can only be provided once');
      }
      listItems = addListItems(args.shift() as string);

    // Test if the argument is a var=val
    } else if (args[0].includes('=')) {
      // var=val
      pushKeyValuePair(keyValuePairs, args.shift() as string);

    // Connection string
    } else {
      if(!conn && !operationType) {
        conn = args.shift();
      } else {
        stream = args.shift();
      }
    }
  }

  if(opt.stdin){
    // read from stdin
    const stdin = process.stdin;
    stdin.setEncoding('utf8');
    stdin.on('data', (data: string) => {
      const lines = data.split('\n');
      lines.forEach(line => {
        if(line.includes('=')) pushKeyValuePair(keyValuePairs, line);
      });
    });
    // await for stdin eof
    await new Promise(resolve => stdin.on('end', resolve));
  }

  if(listItems.length && Object.keys(keyValuePairs).length){
    throw new Error('Cannot mix list items and key-value pairs');
  }

  // Get connection arguments
  const connArgs = getConnectionArgs(opt, conn);

  // Get public key authentication arguments
  const identity = stringOption(opt.identity, '--identity') ?? process.env.NETCONF_IDENTITY;
  if(identity !== undefined && passOnCommandLine(opt, conn)){
    throw new Error('Cannot mix --identity and --password: provide either a private key or a password');
  }
  const privateKey = identity === undefined ? undefined : await readIdentityFile(identity);
  const passphrase = stringOption(opt.passphrase, '--passphrase') ?? process.env.NETCONF_PASSPHRASE;
  let agent: string | undefined;
  if(opt.agent){
    agent = process.env.SSH_AUTH_SOCK;
    if(!agent){
      throw new Error('--agent requires a running ssh agent, but the SSH_AUTH_SOCK environment variable is not set');
    }
  }

  // How long to wait for the server. Given in seconds on the command line, kept in milliseconds
  const timeout = opt.timeout !== undefined
    ? timeoutOption(opt.timeout, '--timeout')
    : timeoutOption(process.env.NETCONF_TIMEOUT, 'NETCONF_TIMEOUT');

  // Datastore that edit-config writes to. --candidate leaves the changes in the candidate datastore,
  // adding --commit applies them to the running configuration once the edit-config succeeded.
  // Committing without editing is the 'com' operation, not a flag
  if(opt.commit && !opt.candidate){
    throw new Error(
      '--commit requires --candidate: use "--candidate --commit" to edit the candidate and commit it, '
      + 'or the "com" operation to commit without editing'
    );
  }
  const datastore: NetconfDatastore | undefined = opt.candidate ? 'candidate' : undefined;
  const autoCommit = Boolean(opt.commit);


  // Determine the operation type to be performed
  if(opt.hello){
    operationType = OperationType.HELLO;
  }else if(Object.keys(keyValuePairs).length && operationType === undefined){
    // If there are key-value pairs, and the operation is not set, change the operation to MERGE
    operationType = OperationType.MERGE;
  }else if(operationType === undefined){
    // If operation is not set, assume GET
    operationType = OperationType.GET;
    if(listItems.length){
      throw new Error('List items can only be provided for create and delete operations');
    }
  }

  if(Number(opt['config-only']) + Number(opt['state-only']) + Number(opt['schema-only']) > 1){
    throw new Error('Cannot mix --config-only, --state-only and --schema-only');
  }

  // Which form the value arguments took, shared by create, delete and replace. `list` only when
  // leaf-list items were actually given: with neither form present this must still be `keyvalue`,
  // so that an argument-less operation edits the node the XPath addresses. Falling back to `list`
  // there sent an edit-config whose target node was an empty array - no nc:operation anywhere, so
  // the server replied <ok/> and changed nothing. The two forms are mutually exclusive; mixing
  // them is rejected above.
  const editConfigValues: EditConfigValues = listItems.length
    ? { type: 'list', values: listItems }
    : { type: 'keyvalue', values: keyValuePairs };

  const operationMap: Record<OperationType, (xpath?: string) => Operation> = {
    [OperationType.HELLO]: () => ({ type: OperationType.HELLO }),
    [OperationType.GET]: (x?: string) => ({
      type: OperationType.GET,
      options: {
        xpath: x ?? DEFAULT_XPATH,
        configFilter: opt['config-only']
          ? GetDataResultType.CONFIG
          : opt['state-only']
            ? GetDataResultType.STATE
            : opt['schema-only']
              ? GetDataResultType.SCHEMA
              : undefined,
        fullTree: opt['full-tree'] || opt['show-namespaces'],
        showNamespaces: opt['show-namespaces'],
      },
    }),
    [OperationType.MERGE]: (x?: string) => ({
      type: OperationType.MERGE,
      options: {
        xpath: x ?? DEFAULT_XPATH,
        values: keyValuePairs,
        allowMultiple: opt['allow-multiple'],
      },
    }),
    [OperationType.CREATE]: (x?: string) => ({
      type: OperationType.CREATE,
      options: {
        xpath: x ?? DEFAULT_XPATH,
        editConfigValues,
        beforeKey: opt['before-key'],
        allowMultiple: opt['allow-multiple'],
      },
    }),
    [OperationType.DELETE]: (x?: string) => ({
      type: OperationType.DELETE,
      options: {
        xpath: x ?? DEFAULT_XPATH,
        editConfigValues,
        allowMultiple: opt['allow-multiple'],
      },
    }),
    [OperationType.REPLACE]: (x?: string) => ({
      type: OperationType.REPLACE,
      options: {
        xpath: x ?? DEFAULT_XPATH,
        editConfigValues,
        allowMultiple: opt['allow-multiple'],
      },
    }),
    [OperationType.SUBSCRIBE]: (x?: string) => ({
      type: OperationType.SUBSCRIBE,
      options: stream ? {
        type: 'stream',
        stream,
      } : {
        type: 'xpath',
        xpath: x ?? DEFAULT_XPATH,
      },
    }),
    [OperationType.RPC]: (x?: string) => ({
      type: OperationType.RPC,
      options: {
        cmd: x ?? DEFAULT_XPATH,
        values: keyValuePairs,
      },
    }),
    [OperationType.COMMIT]: () => ({ type: OperationType.COMMIT }),
    [OperationType.DISCARD]: () => ({ type: OperationType.DISCARD }),
  };

  const operation = operationMap[operationType](xpath);

  if(Number(opt.json) + Number(opt.xml) + Number(opt.yaml) > 1){
    throw new Error('Cannot mix --json, --xml and --yaml');
  }

  const namespaces: (string | NamespaceType)[] = [];
  Object.keys(opt).forEach(key => {
    if(key.startsWith('xmlns')){
      if(key.includes(':')){
        const idx = key.indexOf(':');
        const alias = key.substring(idx + 1);
        if(Array.isArray(opt[key])){
          throw new Error(`Namespace provided twice (${key})`);
        }
        const uri = opt[key];
        namespaces.push({ alias, uri });
      }else{
        if(Array.isArray(opt[key])){
          throw new Error(`Namespace provided twice (${key})`);
        }
        namespaces.push(opt[key]);
      }
    }
  });

  // Fall back to the namespace from the environment. Command line --xmlns flags take precedence,
  // the same way they do for the connection arguments
  if(!namespaces.length && process.env.NETCONF_NAMESPACE){
    namespaces.push(process.env.NETCONF_NAMESPACE);
  }

  // Resolve the password. A private key rules out a password completely: providing both on the
  // command line is an error, and a password left over in the environment is not meant as a second
  // authentication method. The default password is only a fallback for password authentication:
  // sending it next to a key or an agent would spend a failed password attempt on every connection,
  // which some servers count towards locking the account out.
  let pass: string | undefined;
  if(privateKey === undefined){
    pass = connArgs.pass ?? (agent ? undefined : DEFAULT_PASS);
  }

  const cliOptions: CliOptions = {
    host: connArgs.host,
    port: connArgs.port ?? DEFAULT_PORT,
    user: connArgs.user ?? DEFAULT_USER,
    pass,
    privateKey,
    passphrase,
    agent,
    timeout,
    datastore,
    autoCommit,
    operation,
    namespaces,
    readOnly: opt['read-only'],
    resultFormat:
      opt.json ? ResultFormat.JSON : opt.xml ? ResultFormat.XML : opt.yaml ? ResultFormat.YAML
        : opt.keyvalue ? ResultFormat.KEYVALUE : ResultFormat.TREE,
  };

  return cliOptions;
}

/**
 * Test whether a password was provided on the command line, either with the -P flag or inside the
 * connection string. A password that comes from the environment is not a command line argument: it
 * is an ambient default and does not conflict with an explicitly requested key.
 *
 * @param opt - Command line options
 * @param connStr - Connection string, if present in command line arguments
 * @returns True if the command line carries a password
 */
function passOnCommandLine(opt: getoptsImport.ParsedOptions, connStr?: string): boolean {
  return opt.pass !== undefined || (connStr !== undefined && parseConnStr(connStr).pass !== undefined);
}

/**
 * Validate an option that requires a value. getopts yields `true` for a flag given without a value
 * and an array for a flag given more than once.
 *
 * @param value - The value of the option as parsed by getopts
 * @param name - The name of the option, used in the error message
 * @returns The value of the option, or undefined if the option was not provided
 */
function stringOption(value: SafeAny, name: string): string | undefined {
  if(value === undefined || value === ''){
    return undefined;
  }
  if(Array.isArray(value)){
    throw new Error(`Option ${name} provided more than once`);
  }
  if(typeof value !== 'string'){
    throw new Error(`Option ${name} requires a value`);
  }
  return value;
}

/**
 * Parse a timeout given in seconds and convert it to milliseconds. getopts turns a numeric value
 * into a number, while a value taken from the environment is a string, so both are accepted.
 *
 * @param value - The timeout in seconds, as parsed by getopts or taken from the environment
 * @param name - The name of the option or of the environment variable, used in the error message
 * @returns The timeout in milliseconds, or undefined if it was not provided
 */
function timeoutOption(value: SafeAny, name: string): number | undefined {
  if(value === undefined || value === ''){
    return undefined;
  }
  if(Array.isArray(value)){
    throw new Error(`${name} provided more than once`);
  }
  if(typeof value === 'boolean'){
    throw new Error(`${name} requires a value`);
  }
  const seconds = Number(value);
  if(!Number.isFinite(seconds) || seconds <= 0){
    throw new Error(`${name} requires a positive number of seconds`);
  }
  return seconds * MS_IN_SECOND;
}

/**
 * Read a private key from a file. A leading `~/` is expanded, so that the path also works when it
 * comes from the environment, where the shell does not expand it.
 *
 * @param path - Path to the private key file
 * @returns The content of the private key file
 */
async function readIdentityFile(path: string): Promise<Buffer> {
  const expanded = path.startsWith('~/') ? join(homedir(), path.substring(2)) : path;
  try{
    return await readFile(expanded);
  }catch(err){
    throw new Error(`Cannot read the identity file ${expanded}: ${(err as Error).message}`);
  }
}

function pushKeyValuePair(obj: NetconfType, argument: string): void {
  const idx = argument.indexOf('=');
  const key = argument.substring(0, idx).trim();
  const val = argument.substring(idx + 1);
  if(key.length) setNestedValue(obj, key, val);
}

/**
 * Set a nested value in an object using a dot notation
 *
 * @param obj - The object to set the value in
 * @param key - The key to set the value in, use `/` for nested properties, for example, 'a/b/c' should result into object with
 *   nested properties a, a.b and a.b.c
 * @param value - The value to set
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
function setNestedValue(obj: NetconfType, key: string, value: string): void {
  // double slash/wildcard is not allowed
  if (key.includes('//') || key.includes('*')) {
    throw new Error('Cannot use double slash or wildcard in key');
  }
  // remove leading and trailing slashes
  if (key.startsWith('/')) key = key.substring(1);
  if (key.endsWith('/')) key = key.substring(0, key.length - 1);

  const keys = key.split('/');

  let current: SafeAny = obj;
  for (let i = 0; i < keys.length; i++) {
    const arrayMatch = keys[i].match(/^(.+)\[(\d+)]$/);
    if (arrayMatch) {
      const arrayKey = arrayMatch[1];
      const arrayIndex = parseInt(arrayMatch[2], 10) - 1; // Convert to zero-based index

      if (!current[arrayKey]) {
        current[arrayKey] = [];
      } else if (!Array.isArray(current[arrayKey])) {
        throw new Error(`Expected ${arrayKey} to be an array`);
      }

      // Ensure the array has enough elements
      while (current[arrayKey].length <= arrayIndex) {
        current[arrayKey].push({});
      }

      if (i === keys.length - 1) {
        current[arrayKey][arrayIndex] = value;
      } else {
        current = current[arrayKey][arrayIndex];
      }
    } else {
      if (i === keys.length - 1) {
        current[keys[i]] = value;
      } else {
        if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
          current[keys[i]] = {};
        }
        current = current[keys[i]];
      }
    }
  }
}


function addListItems(argument: string): string[] {
  if(!RegExp(/^\[.*]$/).test(argument)) {
    throw new Error('Invalid list, List must be enclosed in square brackets');
  }
  // remove square brackets
  const val = argument.trim().substring(1, argument.length - 1);
  // split on comma
  return val.split(',').map(item => item.trim());
}
/**
 * Get connection arguments from environment or command line arguments or connection string
 * Command line arguments override environment variables.
 * Connection string overrides command line arguments.
 *
 * @param opt - Command line options
 * @param connStr - Connection string, if present in command line arguments
 * @returns Connection arguments
 */
function getConnectionArgs(opt: getoptsImport.ParsedOptions, connStr?: string): ConnArgs {
  const envConfig = removeUndefined({
    host: process.env.NETCONF_HOST,
    port: process.env.NETCONF_PORT ? parseInt(process.env.NETCONF_PORT, 10) : undefined,
    user: process.env.NETCONF_USER,
    pass: process.env.NETCONF_PASS,
  });

  const connConfig = connStr ? removeUndefined(parseConnStr(connStr)) : {};

  const argsConfig = removeUndefined({
    host: opt.host,
    port: opt.port,
    user: opt.user,
    pass: opt.pass,
  });


  const config = {
    ...envConfig,
    ...argsConfig,
    ...connConfig,
  };

  if(!config.host) {
    throw new Error('Host is not provided. Use -H flag, NETCONF_HOST environment variable, or connection string.');
  }
  return {
    host: config.host as string,
    port: config.port as number,
    user: config.user as string,
    pass: config.pass as string,
  };
}

function removeUndefined(obj: Record<string, string | number | undefined>): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, value]) => value !== undefined)
  ) as Record<string, string | number>;
}