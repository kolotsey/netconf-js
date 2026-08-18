// import * as getoptsImport from 'getopts';
import * as getoptsImport from 'getopts';
import * as packageJson from '../../package.json' with { type: 'json' };
import { GetDataResultType, NamespaceType, NetconfType, SafeAny } from '../lib/index.ts';
import { showHelp } from './help.ts';
import { Output } from './output.ts';
import { ConnArgs, parseConnStr } from './parse-conn-str.ts';

export const DEFAULT_USER = 'admin';
export const DEFAULT_PASS = 'admin';
export const DEFAULT_PORT = 2022;
export const DEFAULT_XPATH = '/';

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
  | { type: OperationType.RPC, options: RpcOptions };

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
   * Netconf password
   */
  pass: string;

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
      j: 'json',
      k: ['keyvalue', 'key-value'],
      p: 'port',
      P: 'pass',
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
      allowmultiple: false,
      beforekey: undefined,
      configonly: false,
      fulltree: false,
      host: undefined,
      json: false,
      keyvalue: false,
      namespace: undefined,
      pass: undefined,
      port: undefined,
      readonly: false,
      schemaonly: false,
      stateonly: false,
      stdin: false,
      user: undefined,
      shownamespaces: false,
      xml: false,
      yaml: false,
      hello: false,
    },
    // eslint-disable-next-line id-denylist
    boolean: [
      'allowmultiple', 'configonly', 'fulltree', 'help', 'json', 'keyvalue', 'read-only', 'schemaonly',
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
        editConfigValues: Object.keys(keyValuePairs).length
          ? {
            type: 'keyvalue',
            values: keyValuePairs,
          }
          : {
            type: 'list',
            values: listItems,
          },
        beforeKey: opt['before-key'],
        allowMultiple: opt['allow-multiple'],
      },
    }),
    [OperationType.DELETE]: (x?: string) => ({
      type: OperationType.DELETE,
      options: {
        xpath: x ?? DEFAULT_XPATH,
        editConfigValues: Object.keys(keyValuePairs).length
          ? {
            type: 'keyvalue',
            values: keyValuePairs,
          }
          : {
            type: 'list',
            values: listItems,
          },
        allowMultiple: opt['allow-multiple'],
      },
    }),
    [OperationType.REPLACE]: (x?: string) => ({
      type: OperationType.REPLACE,
      options: {
        xpath: x ?? DEFAULT_XPATH,
        editConfigValues: Object.keys(keyValuePairs).length
          ? {
            type: 'keyvalue',
            values: keyValuePairs,
          }
          : {
            type: 'list',
            values: listItems,
          },
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

  const cliOptions: CliOptions = {
    host: connArgs.host,
    port: connArgs.port ?? DEFAULT_PORT,
    user: connArgs.user ?? DEFAULT_USER,
    pass: connArgs.pass ?? DEFAULT_PASS,
    operation,
    namespaces,
    readOnly: opt['read-only'],
    resultFormat:
      opt.json ? ResultFormat.JSON : opt.xml ? ResultFormat.XML : opt.yaml ? ResultFormat.YAML
        : opt.keyvalue ? ResultFormat.KEYVALUE : ResultFormat.TREE,
  };

  return cliOptions;
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