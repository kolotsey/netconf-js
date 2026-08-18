import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OperationType, parseArgs, ResultFormat } from '../../src/cli/parse-args';
import { Output } from '../../src/cli/output';
import { GetDataResultType } from '../../src/lib';

// Mock process.argv and environment variables
const ORIGINAL_ARGV = process.argv;

beforeEach(() => {
  process.argv = [...ORIGINAL_ARGV];
  vi.stubEnv('NETCONF_HOST', undefined);
  vi.stubEnv('NETCONF_PORT', undefined);
  vi.stubEnv('NETCONF_USER', undefined);
  vi.stubEnv('NETCONF_PASS', undefined);
  vi.stubEnv('NETCONF_NAMESPACE', undefined);
  // Suppress console output
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.argv = [...ORIGINAL_ARGV];
});

describe('info output', () => {
  test('when --help is provided, print help and return undefined', async () => {
    process.argv = ['node', 'netconf', '--help'];
    expect(await parseArgs()).toBe(undefined);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('Commands:'));
  });

  test('when --version is provided, print version and return undefined', async () => {
    process.argv = ['node', 'netconf', '--version'];
    expect(await parseArgs()).toBe(undefined);
    expect(console.info).toHaveBeenCalledWith(expect.stringMatching(/^(?:\d+\.?)+$/));
  });
});

describe('parse connection arguments', () => {
  test('parse environment variables', async () => {
    vi.stubEnv('NETCONF_HOST', 'host');
    vi.stubEnv('NETCONF_PORT', '1234');
    vi.stubEnv('NETCONF_USER', 'user');
    vi.stubEnv('NETCONF_PASS', 'pass');
    process.argv = ['node', 'netconf'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      host: 'host',
      port: 1234,
      user: 'user',
      pass: 'pass',
    }));
  });

  test('parse connection string', async () => {
    process.argv = ['node', 'netconf', 'user:pass@host:1234'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      host: 'host',
      port: 1234,
      user: 'user',
      pass: 'pass',
    }));
  });

  test('parse command line arguments', async () => {
    process.argv = ['node', 'netconf', '-H', 'host', '-p', '1234', '-U', 'user', '-P', 'pass'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      host: 'host',
      port: 1234,
      user: 'user',
      pass: 'pass',
    }));
  });

  test('merge from env, conn-str, and args', async () => {
    vi.stubEnv('NETCONF_USER', 'user1');
    vi.stubEnv('NETCONF_PASS', 'pass1');
    process.argv = ['node', 'netconf', '-p', '5678', 'host2'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      host: 'host2',
      port: 5678,
      user: 'user1',
      pass: 'pass1',
    }));
  });

  test('error on invalid connection string', async () => {
    process.argv = ['node', 'netconf', 'user:pass'];
    await expect(parseArgs()).rejects.toThrow('Invalid connection string');
  });

  test('error when host is not provided', async () => {
    process.argv = ['node', 'netconf'];
    await expect(parseArgs()).rejects.toThrow('Host is not provided. Use -H flag, NETCONF_HOST environment variable, or connection string.');
  });
});

describe('parse arguments', () => {
  test('parse default arguments', () => {
    process.argv = ['node', 'netconf', 'localhost'];
    expect(parseArgs()).toEqual(expect.objectContaining({}));
  });

  test.each([
    ['-V', 1],
    ['--verbose', 1],
    ['-VV', 2],
  ])('parse verbose', (option, expected) => {
    process.argv = ['node', 'netconf', 'localhost', option];
    parseArgs();
    expect(Output.verbosity).toBe(expected);
  });

  test.each([
    [[], OperationType.GET],
    [['var=val'], OperationType.MERGE],
    [['set', 'var=val'], OperationType.MERGE],
    [['del', 'var=val'], OperationType.DELETE],
    [['add', 'var=val'], OperationType.CREATE],
    [['get'], OperationType.GET],
    [['rpc', 'var=val'], OperationType.RPC],
    [['sub'], OperationType.SUBSCRIBE],
    [['--hello', 'set', 'var=val'], OperationType.HELLO],
    // Every accepted alias, including the ones that carry no key-value pairs and so cannot be
    // inferred from the arguments
    [['upd', 'var=val'], OperationType.MERGE],
    [['upd'], OperationType.MERGE],
    [['update', 'var=val'], OperationType.MERGE],
    [['mer', 'var=val'], OperationType.MERGE],
    [['merge', 'var=val'], OperationType.MERGE],
    [['cre', 'var=val'], OperationType.CREATE],
    [['create', 'var=val'], OperationType.CREATE],
    [['rem', 'var=val'], OperationType.DELETE],
    [['remove', 'var=val'], OperationType.DELETE],
    [['delete', 'var=val'], OperationType.DELETE],
    [['rep', 'var=val'], OperationType.REPLACE],
    [['replace', 'var=val'], OperationType.REPLACE],
    [['subscribe'], OperationType.SUBSCRIBE],
    [['exec', 'var=val'], OperationType.RPC],
  ])('parse operation type: "%s"', async (option, expected) => {
    process.argv = ['node', 'netconf', 'localhost', ...option];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      operation: expect.objectContaining({
        type: expected,
      }),
    }));
  });

  // The keyword is matched against the whole argument: a prefix match would turn a host name into
  // an operation and a mistyped keyword into a destructive operation
  test.each([
    ['deleteme'],
    ['submarine'],
    ['updated'],
    ['typo'],
    // `in` would find these on the prototype of the alias table
    ['constructor'],
    ['toString'],
  ])('do not treat "%s" as an operation', async option => {
    process.argv = ['node', 'netconf', 'localhost', '/foo', option];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      operation: expect.objectContaining({
        type: OperationType.GET,
      }),
    }));
  });

  test('a host name that starts with an operation keyword is still a host name', async () => {
    process.argv = ['node', 'netconf', 'subnet.example.com', '/foo'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      host: 'subnet.example.com',
      operation: expect.objectContaining({
        type: OperationType.GET,
      }),
    }));
  });

  test.each([
    ['--config-only', GetDataResultType.CONFIG],
    ['--state-only', GetDataResultType.STATE],
    ['--schema-only', GetDataResultType.SCHEMA],
  ])('parse config-only, state-only, schema-only', async (option, expected) => {
    process.argv = ['node', 'netconf', 'localhost', option];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      operation: expect.objectContaining({
        options: expect.objectContaining({
          configFilter: expected,
        }),
      }),
    }));
  });

  test.each([
    ['netconf', 'stream'],
    ['/', 'xpath'],
  ])('parse stream and xpath', async (option, expected) => {
    process.argv = ['node', 'netconf', 'localhost', 'sub', option];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      operation: expect.objectContaining({
        options: expect.objectContaining({
          type: expected,
        }),
      }),
    }));
    process.argv = ['node', 'netconf', 'localhost', option, 'sub'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      operation: expect.objectContaining({
        options: expect.objectContaining({
          type: expected,
        }),
      }),
    }));
  });

  test.each([
    [['--json'], ResultFormat.JSON],
    [['--xml'], ResultFormat.XML],
    [['--yaml'], ResultFormat.YAML],
    [['--keyvalue'], ResultFormat.KEYVALUE],
    [['--key-value'], ResultFormat.KEYVALUE],
    [['-k'], ResultFormat.KEYVALUE],
    [['-j'], ResultFormat.JSON],
    [['-x'], ResultFormat.XML],
    [['-y'], ResultFormat.YAML],
    [[], ResultFormat.TREE],
  ])('parse result format for "%s"', async (option, expected) => {
    process.argv = ['node', 'netconf', 'localhost', ...option];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      resultFormat: expected,
    }));
  });

  test('take the namespace from NETCONF_NAMESPACE', async () => {
    vi.stubEnv('NETCONF_NAMESPACE', 'http://example.com/env');
    process.argv = ['node', 'netconf', 'localhost'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      namespaces: ['http://example.com/env'],
    }));
  });

  test('--xmlns overrides NETCONF_NAMESPACE', async () => {
    vi.stubEnv('NETCONF_NAMESPACE', 'http://example.com/env');
    process.argv = ['node', 'netconf', 'localhost', '--xmlns=http://example.com/cli'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      namespaces: ['http://example.com/cli'],
    }));
  });

  test('--xmlns with an alias overrides NETCONF_NAMESPACE', async () => {
    vi.stubEnv('NETCONF_NAMESPACE', 'http://example.com/env');
    process.argv = ['node', 'netconf', 'localhost', '--xmlns:x=http://example.com/cli'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      namespaces: [{ alias: 'x', uri: 'http://example.com/cli' }],
    }));
  });

  test('no namespace when neither NETCONF_NAMESPACE nor --xmlns is provided', async () => {
    process.argv = ['node', 'netconf', 'localhost'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      namespaces: [],
    }));
  });

  test('parse operation and xpath', async () => {
    process.argv = ['node', 'netconf', 'localhost', '/foo/bar'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      operation: {
        type: 'get',
        options: expect.objectContaining({
          xpath: '/foo/bar',
        }),
      },
    }));
  });

  test.each([
    ['key=value', {key: 'value'}, 'keyvalue'],
    ['[key=value]', ['key=value'], 'list'],
  ])('correctly set operation values for "add" operation', async (option, expected, expectedType) => {
    process.argv = ['node', 'netconf', 'localhost', '/foo', 'add', option];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      operation: expect.objectContaining({
        type: 'create',
        options: expect.objectContaining({
          editConfigValues: expect.objectContaining({
            type: expectedType,
            values: expected,
          }),
        }),
      }),
    }));
  });

  test.each([
    ['key=value', {key: 'value'}, 'keyvalue'],
    ['[key=value]', ['key=value'], 'list'],
  ])('correctly set operation values for "del" operation', async (option, expected, expectedType) => {
    process.argv = ['node', 'netconf', 'localhost', '/foo', 'del', option];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      operation: expect.objectContaining({
        type: 'delete',
        options: expect.objectContaining({
          editConfigValues: expect.objectContaining({
            type: expectedType,
            values: expected,
          }),
        }),
      }),
    }));
  });

  test.each([
    [['key=value'], {key: 'value'}],
    [['key1=value1', 'key2=value2'], {key1: 'value1', key2: 'value2'}],
    [['root/key1=value1', 'root/key2=value2'], {root: {key1: 'value1', key2: 'value2'}}],
    [['foo/bar[1]/baz=1', 'foo/bar[2]/baz=2', 'foo/biz=3'], {foo: {bar: [{baz: '1'}, {baz: '2'}], biz: '3'}}],
    [['foo/bar[2]/baz=2', 'foo/bar[1]/baz=1', 'foo/biz=3'], {foo: {bar: [{baz: '1'}, {baz: '2'}], biz: '3'}}],
  ])('nested values for "%s"', async (option, expected) => {
    process.argv = ['node', 'netconf', 'localhost', '/foo', 'add', ...option];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      operation: expect.objectContaining({
        options: expect.objectContaining({
          editConfigValues: expect.objectContaining({
            values: expected,
          }),
        }),
      }),
    }));
  });
});

describe('error handling', () => {
  test.each([
    '--invalid-option',
    '-z',
  ])('error on invalid options: "%s"', async option => {
    process.argv = ['node', 'netconf', 'localhost', option];
    await expect(parseArgs()).rejects.toThrow('Unknown option');
  });

  test('error on mixing array and key-value', async () => {
    process.argv = ['node', 'netconf', 'localhost', '/foo', 'a=1', '[b]'];
    await expect(parseArgs()).rejects.toThrow('Cannot mix list items and key-value pairs');
  });

  test('error on mixing config-only and state-only', async () => {
    process.argv = ['node', 'netconf', 'localhost', '--config-only', '--state-only'];
    await expect(parseArgs()).rejects.toThrow('Cannot mix --config-only, --state-only and --schema-only');
  });

  test('error on mixing result format', async () => {
    process.argv = ['node', 'netconf', 'localhost', '--json', '--xml'];
    await expect(parseArgs()).rejects.toThrow('Cannot mix --json, --xml and --yaml');
  });

  test('error when providing list items multiple times', async () => {
    process.argv = ['node', 'netconf', 'localhost', '/foo', '[a]', '[b]'];
    await expect(parseArgs()).rejects.toThrow('List items can only be provided once');
  });

  test('error when providing list items for non-list operations', async () => {
    process.argv = ['node', 'netconf', 'localhost', '/foo', '[a]'];
    await expect(parseArgs()).rejects.toThrow('List items can only be provided for create and delete operations');
  });

  test('error when list format is invalid', async () => {
    process.argv = ['node', 'netconf', 'localhost', '/foo', '[a'];
    await expect(parseArgs()).rejects.toThrow('Invalid list, List must be enclosed in square brackets');
  });
});
