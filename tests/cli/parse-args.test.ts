import { mkdtemp, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_PASS, OperationType, parseArgs, ResultFormat } from '../../src/cli/parse-args';
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
  vi.stubEnv('NETCONF_IDENTITY', undefined);
  vi.stubEnv('NETCONF_PASSPHRASE', undefined);
  vi.stubEnv('SSH_AUTH_SOCK', undefined);
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

  test.each([
    ['-P'],
    ['--pass'],
    ['--password'],
  ])('parse the password given with "%s"', async option => {
    process.argv = ['node', 'netconf', 'host', option, 'secret'];
    expect(await parseArgs()).toEqual(expect.objectContaining({ pass: 'secret' }));
  });

  test.each([
    ['-U'],
    ['--user'],
  ])('parse the user given with "%s"', async option => {
    process.argv = ['node', 'netconf', 'host', option, 'someone'];
    expect(await parseArgs()).toEqual(expect.objectContaining({ user: 'someone' }));
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

describe('timeout', () => {
  test.each([
    ['30', 30000],
    ['0.5', 500],
    ['1', 1000],
  ])('parse --timeout %s as %i milliseconds', async (option, expected) => {
    process.argv = ['node', 'netconf', 'localhost', '--timeout', option];
    expect(await parseArgs()).toEqual(expect.objectContaining({ timeout: expected }));
  });

  test('no timeout in the options when the flag is not provided, so the library default applies', async () => {
    process.argv = ['node', 'netconf', 'localhost'];
    expect(await parseArgs()).toEqual(expect.objectContaining({ timeout: undefined }));
  });

  test('take the timeout from NETCONF_TIMEOUT', async () => {
    vi.stubEnv('NETCONF_TIMEOUT', '45');
    process.argv = ['node', 'netconf', 'localhost'];
    expect(await parseArgs()).toEqual(expect.objectContaining({ timeout: 45000 }));
  });

  test('--timeout overrides NETCONF_TIMEOUT', async () => {
    vi.stubEnv('NETCONF_TIMEOUT', '45');
    process.argv = ['node', 'netconf', 'localhost', '--timeout', '10'];
    expect(await parseArgs()).toEqual(expect.objectContaining({ timeout: 10000 }));
  });

  test.each([
    [['--timeout', '0']],
    [['--timeout', 'abc']],
    [['--timeout', 'Infinity']],
    // A negative value has to use "=", getopts reads "--timeout -5" as the short option -5
    [['--timeout=-5']],
  ])('error on an invalid timeout "%s"', async args => {
    process.argv = ['node', 'netconf', 'localhost', ...args];
    await expect(parseArgs()).rejects.toThrow('--timeout requires a positive number of seconds');
  });

  test('error on an invalid NETCONF_TIMEOUT', async () => {
    vi.stubEnv('NETCONF_TIMEOUT', 'soon');
    process.argv = ['node', 'netconf', 'localhost'];
    await expect(parseArgs()).rejects.toThrow('NETCONF_TIMEOUT requires a positive number of seconds');
  });

  test('error when --timeout is provided without a value', async () => {
    process.argv = ['node', 'netconf', 'localhost', '--timeout'];
    await expect(parseArgs()).rejects.toThrow('--timeout requires a value');
  });

  test('error when --timeout is provided more than once', async () => {
    process.argv = ['node', 'netconf', 'localhost', '--timeout', '10', '--timeout', '20'];
    await expect(parseArgs()).rejects.toThrow('--timeout provided more than once');
  });
});

describe('public key authentication', () => {
  const KEY_CONTENT = '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n';
  let dir: string;
  let keyFile: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'netconf-client-test-'));
    keyFile = join(dir, 'id_test');
    await writeFile(keyFile, KEY_CONTENT);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test.each([
    ['-i'],
    ['--identity'],
  ])('read the private key from the file given with "%s"', async option => {
    process.argv = ['node', 'netconf', 'localhost', option, keyFile];
    const result = await parseArgs();
    expect(result?.privateKey?.toString()).toBe(KEY_CONTENT);
  });

  test('take the identity from NETCONF_IDENTITY', async () => {
    vi.stubEnv('NETCONF_IDENTITY', keyFile);
    process.argv = ['node', 'netconf', 'localhost'];
    const result = await parseArgs();
    expect(result?.privateKey?.toString()).toBe(KEY_CONTENT);
  });

  test('--identity overrides NETCONF_IDENTITY', async () => {
    vi.stubEnv('NETCONF_IDENTITY', join(dir, 'does-not-exist'));
    process.argv = ['node', 'netconf', 'localhost', '-i', keyFile];
    const result = await parseArgs();
    expect(result?.privateKey?.toString()).toBe(KEY_CONTENT);
  });

  test('expand a leading ~/ in the identity path', async () => {
    process.argv = ['node', 'netconf', 'localhost', '-i', '~/.ssh/netconf-client-no-such-key'];
    // The path is reported expanded, which is the only observable effect when the file is missing
    await expect(parseArgs()).rejects.toThrow(
      `Cannot read the identity file ${join(homedir(), '.ssh/netconf-client-no-such-key')}`
    );
  });

  test('the default password is not sent when a key is provided', async () => {
    process.argv = ['node', 'netconf', 'localhost', '-i', keyFile];
    expect(await parseArgs()).toEqual(expect.objectContaining({ pass: undefined }));
  });

  test.each([
    [['localhost', '-i', '<key>', '-P', 'secret']],
    [['localhost', '-P', 'secret', '-i', '<key>']],
    [['localhost', '--pass', 'secret', '--identity', '<key>']],
    [['localhost', '--password', 'secret', '--identity', '<key>']],
    // A password inside the connection string is given on the command line just as -P is
    [['user:secret@localhost', '-i', '<key>']],
  ])('error when a key and a password are both provided: "%s"', async args => {
    process.argv = ['node', 'netconf', ...args.map(a => a === '<key>' ? keyFile : a)];
    await expect(parseArgs()).rejects.toThrow(
      'Cannot mix --identity and --password: provide either a private key or a password'
    );
  });

  test('error when NETCONF_IDENTITY is combined with a password on the command line', async () => {
    vi.stubEnv('NETCONF_IDENTITY', keyFile);
    process.argv = ['node', 'netconf', 'localhost', '-P', 'secret'];
    await expect(parseArgs()).rejects.toThrow('Cannot mix --identity and --password');
  });

  test('a password in the environment is ignored, not rejected, when a key is provided', async () => {
    vi.stubEnv('NETCONF_PASS', 'from-env');
    process.argv = ['node', 'netconf', 'localhost', '-i', keyFile];
    expect(await parseArgs()).toEqual(expect.objectContaining({ pass: undefined }));
  });

  test('a user in the connection string is still accepted alongside a key', async () => {
    process.argv = ['node', 'netconf', 'user@localhost', '-i', keyFile];
    expect(await parseArgs()).toEqual(expect.objectContaining({ user: 'user', pass: undefined }));
  });

  test('--agent can be combined with a password, which is tried first', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/ssh-agent.sock');
    process.argv = ['node', 'netconf', 'localhost', '--agent', '-P', 'secret'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      agent: '/tmp/ssh-agent.sock',
      pass: 'secret',
    }));
  });

  test('the default password still applies without a key or an agent', async () => {
    process.argv = ['node', 'netconf', 'localhost'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      pass: DEFAULT_PASS,
      privateKey: undefined,
      agent: undefined,
    }));
  });

  test.each([
    ['--passphrase', 'from-flag'],
  ])('parse the passphrase from "%s"', async (option, expected) => {
    process.argv = ['node', 'netconf', 'localhost', '-i', keyFile, option, expected];
    expect(await parseArgs()).toEqual(expect.objectContaining({ passphrase: expected }));
  });

  test('take the passphrase from NETCONF_PASSPHRASE', async () => {
    vi.stubEnv('NETCONF_PASSPHRASE', 'from-env');
    process.argv = ['node', 'netconf', 'localhost', '-i', keyFile];
    expect(await parseArgs()).toEqual(expect.objectContaining({ passphrase: 'from-env' }));
  });

  test('--passphrase overrides NETCONF_PASSPHRASE', async () => {
    vi.stubEnv('NETCONF_PASSPHRASE', 'from-env');
    process.argv = ['node', 'netconf', 'localhost', '-i', keyFile, '--passphrase', 'from-flag'];
    expect(await parseArgs()).toEqual(expect.objectContaining({ passphrase: 'from-flag' }));
  });

  test('--agent takes the socket from SSH_AUTH_SOCK and suppresses the default password', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/ssh-agent.sock');
    process.argv = ['node', 'netconf', 'localhost', '--agent'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      agent: '/tmp/ssh-agent.sock',
      pass: undefined,
    }));
  });

  test('the agent is not used unless --agent is provided', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/ssh-agent.sock');
    process.argv = ['node', 'netconf', 'localhost'];
    expect(await parseArgs()).toEqual(expect.objectContaining({
      agent: undefined,
      pass: DEFAULT_PASS,
    }));
  });

  test('error when --agent is provided without a running agent', async () => {
    process.argv = ['node', 'netconf', 'localhost', '--agent'];
    await expect(parseArgs()).rejects.toThrow('SSH_AUTH_SOCK environment variable is not set');
  });

  test('error when the identity file cannot be read', async () => {
    process.argv = ['node', 'netconf', 'localhost', '-i', join(dir, 'does-not-exist')];
    await expect(parseArgs()).rejects.toThrow('Cannot read the identity file');
  });

  test('error when --identity is provided without a value', async () => {
    process.argv = ['node', 'netconf', 'localhost', '--identity'];
    await expect(parseArgs()).rejects.toThrow('Option --identity requires a value');
  });

  test('error when --identity is provided more than once', async () => {
    process.argv = ['node', 'netconf', 'localhost', '-i', keyFile, '-i', keyFile];
    await expect(parseArgs()).rejects.toThrow('Option --identity provided more than once');
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
