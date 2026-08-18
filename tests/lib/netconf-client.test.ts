/* eslint-disable max-lines-per-function */
import { firstValueFrom, Observable, Subject } from 'rxjs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NetconfClient } from '../../src/lib/netconf-client';
import { CreateSubscriptionRequest, NetconfType, NotificationResult, RpcReply, SafeAny } from '../../src/lib/index.ts';

// Mock ssh2 Client
const mockOn = vi.fn();
const mockConnect = vi.fn();
const mockEnd = vi.fn();
const mockRemoveListener = vi.fn();
const mockRemoveAllListeners = vi.fn();
const mockDestroy = vi.fn();
const mockSubsys = vi.fn();

vi.mock('ssh2', () => ({
  Client: vi.fn().mockImplementation(() => ({
    on: mockOn,
    connect: mockConnect,
    end: mockEnd,
    removeListener: mockRemoveListener,
    removeAllListeners: mockRemoveAllListeners,
    destroy: mockDestroy,
    subsys: mockSubsys,
  })),
}));

class NetconfClientTest extends NetconfClient {
  public rpcExec(rpc: NetconfType): Observable<RpcReply> {
    return super.rpcExec(rpc);
  }

  public rpcStream(
    rpc: CreateSubscriptionRequest, stop$?: Subject<void>
  ): Observable<NotificationResult | RpcReply> {
    return super.rpcStream(rpc, stop$);
  }
}

// Poll until the condition holds, failing with the given message on timeout
async function waitFor(condition: () => boolean, message: string, timeoutMs = 100): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await new Promise(r => setTimeout(r, 1));
  }
}

describe('NetconfClient', () => {
  let client: NetconfClientTest;

  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();

    client = new NetconfClientTest({
      host: 'test-host',
      port: 830,
      user: 'test-user',
      pass: 'test-pass',
    });
  });

  describe('constructor', () => {
    test('create instance with correct parameters', () => {
      expect(client).toBeInstanceOf(NetconfClient);
    });
  });

  describe('closing connection', () => {
    test('throw error when trying to close uninitialized connection', async () => {
      await expect(firstValueFrom(client.close())).rejects.toThrow('Trying to close connection that was not opened');
    });
  });

  describe('Error handling', () => {
    test('handle SSH connection error', async () => {
      const mockError = new Error('SSH connection failed');

      // Store error callback to trigger it later
      let errorCallback: ((err: Error) => void) | undefined;
      mockOn.mockImplementation((event: string, callback: () => void) => {
        if (event === 'error') {
          errorCallback = callback;
        }
      });

      // Start hello process which initiates connection
      const helloPromise = firstValueFrom(client.hello());

      // Trigger the error callback
      if (!errorCallback) {
        throw new Error('Error callback not defined - client.on("error") was not called');
      }
      errorCallback(mockError);

      await expect(helloPromise).rejects.toThrow('SSH connection failed');
    });

    test('handle SSH timeout', async () => {
      // Store timeout callback to trigger it later
      let timeoutCallback: (() => void) | undefined;
      mockOn.mockImplementation((event: string, callback: () => void) => {
        if (event === 'timeout') {
          timeoutCallback = callback;
        }
      });

      // Start hello process which initiates connection
      const helloPromise = firstValueFrom(client.hello());

      // Trigger the timeout callback
      if (!timeoutCallback) {
        throw new Error('Timeout callback not defined - client.on("timeout") was not called');
      }
      timeoutCallback();

      await expect(helloPromise).rejects.toThrow('SSH timeout');
    });
  });

  describe('hello', () => {
    test('send and receive hello message', async () => {
      // Store callbacks to simulate channel behavior
      let readyCallback: (() => void) | undefined;
      let subsysCallback: ((err: Error | undefined, channel: SafeAny) => void) | undefined;
      let channelDataCallback: ((data: Buffer) => void) | undefined;

      // Mock SSH connection setup
      mockOn.mockImplementation((event: string, callback: () => void) => {
        if (event === 'ready') {
          readyCallback = callback;
        }
      });

      // Mock subsys call that creates netconf channel
      mockSubsys.mockImplementation((service: string, callback: (err: Error | undefined, channel: SafeAny) => void) => {
        subsysCallback = callback;
      });

      // Create mock channel
      const mockChannel = {
        on: vi.fn((event: string, callback: (data: Buffer) => void) => {
          if (event === 'data') {
            channelDataCallback = callback;
          }
        }),
        write: vi.fn(),
        removeListener: vi.fn(),
        removeAllListeners: vi.fn(),
        destroy: vi.fn(),
      };

      // Start hello process
      const helloPromise = firstValueFrom(client.hello());

      // Simulate successful SSH connection
      if (!readyCallback) {
        throw new Error('Ready callback not defined - client.on("ready") was not called');
      }
      readyCallback();

      // Simulate successful channel creation
      if (!subsysCallback) {
        throw new Error('Subsys callback not defined - client.subsys was not called');
      }
      subsysCallback(undefined, mockChannel);

      // Verify hello message was sent
      expect(mockChannel.write).toHaveBeenCalledWith(expect.stringMatching(/<hello[^>]*>/));

      // Simulate server hello response
      const serverHello = `<?xml version="1.0" encoding="UTF-8"?>
        <hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
          <capabilities>
            <capability>urn:ietf:params:xml:ns:netconf:base:1.0</capability>
            <capability>urn:ietf:params:netconf:capability:xpath:1.0</capability>
          </capabilities>
          <session-id>4</session-id>
        </hello>
        ]]>]]>`;

      if (!channelDataCallback) {
        throw new Error('Channel data callback not defined - mockChannel.on("data") was not called');
      }
      channelDataCallback(Buffer.from(serverHello));

      // Verify hello exchange completed successfully
      const result = await helloPromise;

      expect(result).toBeDefined();
      expect(result.result).toMatchObject({
        hello: {
          capabilities: {
            capability: expect.arrayContaining(['urn:ietf:params:xml:ns:netconf:base:1.0']),
          },
          'session-id': 4,
        },
      });
    });
  });

  describe('rpcExec', () => {
    let mockChannel: SafeAny;
    let channelDataCallback: ((data: Buffer) => void) | undefined;

    // Helper to wait until channelDataCallback is set
    async function waitForChannelDataCallback(timeoutMs = 100): Promise<void> {
      const start = Date.now();
      while (!channelDataCallback) {
        if (Date.now() - start > timeoutMs) throw new Error('Timeout waiting for channelDataCallback');
        await new Promise(r => setTimeout(r, 1));
      }
    }

    async function waitForChannelDataCallbackCleared(timeoutMs = 100): Promise<void> {
      const start = Date.now();
      while (channelDataCallback) {
        if (Date.now() - start > timeoutMs) throw new Error('Timeout waiting for channelDataCallback to be cleared');
        await new Promise(r => setTimeout(r, 1));
      }
    }

    beforeEach(() => {
      // Create mock channel
      mockChannel = {
        on: vi.fn((event: string, callback: (data: Buffer) => void) => {
          if (event === 'data'){
            channelDataCallback = callback;
          }
        }),
        write: vi.fn((_data: Buffer, callback: () => void) => {
          callback?.();
        }),
        removeListener: vi.fn((event: string) => {
          if (event === 'data'){
            channelDataCallback = undefined;
          }
        }),
        removeAllListeners: vi.fn(),
        destroy: vi.fn(),
      };

      // Mock SSH connection setup
      mockOn.mockImplementation((event: string, callback: () => void) => {
        if (event === 'ready') {
          // Store ready callback but don't execute
          setTimeout(() => callback(), 0);
        }
      });

      // Mock subsys call
      mockSubsys.mockImplementation((_svc: string, callback: (err: Error | undefined, channel: SafeAny) => void) => {
        // Return mock channel through callback
        setTimeout(() => callback(undefined, mockChannel), 0);
      });
    });

    test('send and receive rpc message', async () => {
      const helloPromise = firstValueFrom(client.hello());

      await waitForChannelDataCallback();

      if (!channelDataCallback) throw new Error('Channel data callback not defined');

      channelDataCallback(Buffer.from(`
        <hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
          <capabilities><capability>urn:ietf:params:xml:ns:netconf:base:1.0</capability></capabilities>
          <session-id>123</session-id>
        </hello>
        ]]>]]>
      `));

      await helloPromise;

      await waitForChannelDataCallbackCleared();

      // Test RPC
      const rpcPromise: Promise<RpcReply> = firstValueFrom(client.rpcExec({
        'get-config': {
          source: {
            running: {},
          },
        },
      }));

      await waitForChannelDataCallback();

      if (!channelDataCallback) throw new Error('Channel data callback not defined');

      // Verify RPC request was sent
      expect(mockChannel.write).toHaveBeenCalledWith(
        expect.stringMatching(/<rpc.*get-config.*running/s),
        expect.any(Function)
      );

      // Send RPC response
      channelDataCallback(Buffer.from(`
        <rpc-reply message-id="1" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
          <data><config>test</config></data>
        </rpc-reply>
        ]]>]]>
      `));

      const rpcResult = await rpcPromise;
      expect(rpcResult.result?.['rpc-reply']?.data?.config).toBe('test');
    });

    test('handle rpc error response', async () => {
      const helloPromise = firstValueFrom(client.hello());

      await waitForChannelDataCallback();

      if (!channelDataCallback) throw new Error('Channel data callback not defined');

      channelDataCallback(Buffer.from(`
        <hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
          <capabilities><capability>urn:ietf:params:xml:ns:netconf:base:1.0</capability></capabilities>
          <session-id>123</session-id>
        </hello>
        ]]>]]>
      `));

      await helloPromise;

      // Test RPC error handling
      const rpcPromise: Promise<RpcReply> = firstValueFrom(client.rpcExec({
        'invalid-operation': {},
      }));

      channelDataCallback(Buffer.from(`
        <rpc-reply message-id="1" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
          <rpc-error>
            <error-type>protocol</error-type>
            <error-tag>unknown-element</error-tag>
            <error-severity>error</error-severity>
            <error-message>Invalid operation</error-message>
          </rpc-error>
        </rpc-reply>
        ]]>]]>
      `));

      await expect(rpcPromise).rejects.toThrow('Netconf RPC error: Invalid operation');
    });
  });

  describe('state after a connection error', () => {
    let mockChannel: SafeAny;
    let channelDataCallback: ((data: Buffer) => void) | undefined;
    let sshCallbacks: Record<string, SafeAny>;

    // Complete the hello handshake so the connection reaches the 'ready' state
    async function connect(): Promise<void> {
      const helloPromise = firstValueFrom(client.hello());

      await waitFor(() => !!channelDataCallback, 'Timeout waiting for the hello listener');

      channelDataCallback?.(Buffer.from(`
        <hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
          <capabilities><capability>urn:ietf:params:xml:ns:netconf:base:1.0</capability></capabilities>
          <session-id>123</session-id>
        </hello>
        ]]>]]>
      `));

      await helloPromise;
    }

    // Send a request that the server rejects with an rpc-error
    async function failingRequest(): Promise<void> {
      const rpcPromise: Promise<RpcReply> = firstValueFrom(client.rpcExec({ 'invalid-operation': {} }));

      await waitFor(() => !!channelDataCallback, 'Timeout waiting for the rpc-reply listener');

      channelDataCallback?.(Buffer.from(`
        <rpc-reply message-id="1" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
          <rpc-error>
            <error-type>protocol</error-type>
            <error-tag>unknown-element</error-tag>
            <error-severity>error</error-severity>
            <error-message>Invalid operation</error-message>
          </rpc-error>
        </rpc-reply>
        ]]>]]>
      `));

      await expect(rpcPromise).rejects.toThrow('Netconf RPC error: Invalid operation');
    }

    beforeEach(() => {
      channelDataCallback = undefined;
      sshCallbacks = {};

      mockChannel = {
        on: vi.fn((event: string, callback: (data: Buffer) => void) => {
          if (event === 'data'){
            channelDataCallback = callback;
          }
        }),
        write: vi.fn((_data: Buffer, callback: () => void) => {
          callback?.();
        }),
        removeListener: vi.fn((event: string) => {
          if (event === 'data'){
            channelDataCallback = undefined;
          }
        }),
        removeAllListeners: vi.fn(),
        destroy: vi.fn(),
      };

      // Store every ssh callback so the tests can simulate ssh events
      mockOn.mockImplementation((event: string, callback: SafeAny) => {
        sshCallbacks[event] = callback;
        if (event === 'ready') {
          setTimeout(() => callback(), 0);
        }
      });

      mockSubsys.mockImplementation((_svc: string, callback: (err: Error | undefined, channel: SafeAny) => void) => {
        setTimeout(() => callback(undefined, mockChannel), 0);
      });
    });

    test('report "closed" instead of throwing when the ssh session drops', async () => {
      expect(client.connectionState).toBe('uninitialized');

      await connect();
      expect(client.connectionState).toBe('ready');

      // The ssh layer reports that the session went away
      sshCallbacks.close();

      expect(() => client.connectionState).not.toThrow();
      expect(client.connectionState).toBe('closed');
    });

    test('report closing errors through the returned observable, not synchronously', async () => {
      await connect();

      sshCallbacks.close();

      let close$: Observable<void> | undefined;
      expect(() => {
        close$ = client.close();
      }).not.toThrow();

      await expect(firstValueFrom(close$ as Observable<void>)).resolves.toBeUndefined();
    });

    test('keep the connection usable after the server rejects a request', async () => {
      await connect();
      await failingRequest();

      // A protocol error concerns one request, it must not tear down the session
      expect(client.connectionState).toBe('ready');
      expect(mockChannel.destroy).not.toHaveBeenCalled();

      const rpcPromise: Promise<RpcReply> = firstValueFrom(client.rpcExec({
        'get-config': { source: { running: {} } },
      }));

      await waitFor(() => !!channelDataCallback, 'Timeout waiting for the rpc-reply listener');

      channelDataCallback?.(Buffer.from(`
        <rpc-reply message-id="2" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
          <data><foo>bar</foo></data>
        </rpc-reply>
        ]]>]]>
      `));

      const reply = await rpcPromise;
      expect(reply.result['rpc-reply']).toHaveProperty('data');
    });

    test('release the data listener when a request fails', async () => {
      await connect();
      await failingRequest();

      expect(channelDataCallback).toBeUndefined();
    });

    test('not replay a stale error on a request after the connection dropped', async () => {
      await connect();

      // The ssh layer reports that the session went away
      sshCallbacks.close();

      const error: Error | undefined = await firstValueFrom(client.rpcExec({
        'get-config': { source: { running: {} } },
      })).then(() => undefined, (err: Error) => err);

      // The request reports the closed connection, not the error that closed it
      expect(error?.message).toBe('Trying to use connection that was closed after an error');
    });

    test('report a rejected subscription instead of completing silently', async () => {
      await connect();

      const stop$ = new Subject<void>();
      const streamPromise: Promise<NotificationResult | RpcReply> = firstValueFrom(client.rpcStream({
        'create-subscription': {},
      } as CreateSubscriptionRequest, stop$));

      await waitFor(() => !!channelDataCallback, 'Timeout waiting for the rpc-reply listener');

      // The server answers the subscription request without <ok/>
      channelDataCallback?.(Buffer.from(`
        <rpc-reply message-id="1" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
          <data/>
        </rpc-reply>
        ]]>]]>
      `));

      await expect(streamPromise).rejects.toThrow('Did not receive rpc-reply/ok in response to subscription');
    });
  });
});
