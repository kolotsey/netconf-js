import { BehaviorSubject, catchError, combineLatest, filter, finalize, from, map, merge, NEVER, Observable, of, Subject, switchMap, take, takeUntil, tap, throwError, timeout, timer } from 'rxjs';
import { Client, ClientChannel } from 'ssh2';
import * as xml2js from 'xml2js';
import { NETCONF_DELIM, NetconfBuffer } from './netconf-buffer.ts';
import { CreateSubscriptionRequest, HelloResult, HelloType, NetconfConnectionState, NetconfParams, NetconfType, NotificationResult, RpcErrorType, RpcReply, RpcReplyType, RpcResult, SafeAny, SSH_TIMEOUT } from './netconf-types.ts';

const NETCONF_DEBUG_LEVEL = 1;
const NETCONF_DEBUG_TAG = 'NETCONF';
const NETCONF_DATA_DEBUG_LEVEL = 2;
const NETCONF_DATA_DEBUG_RECV_TAG = 'RECV';
const NETCONF_DATA_DEBUG_SEND_TAG = 'SEND';
const NETCONF_HELLO_DEBUG_LEVEL = 3;

const SSH_DEBUG_TAG = 'SSH';
const SSH_DEBUG_LEVEL = 3;

const NOTIFICATION_REGEXP = new RegExp('<notification[\\s\\S]*</notification>');

/**
 * Netconf client parameters
 */


type ClientChannelState =
  | {
      state: 'uninitialized' | 'connecting' | 'closed';
      channel?: undefined;
    }
  | {
      state: 'ready';
      channel: ClientChannel;
    };

export class NetconfClient {
  /**
   * Get the current connection state
   *
   * @returns {NetconfConnectionState} The current connection state
   */
  public get connectionState(): NetconfConnectionState {
    return this.netconfChannelSubject$?.getValue()?.state ?? 'closed';
  }

  protected params: NetconfParams;

  private sshClient?: Client;

  private idCounter = 0;

  private xmlBuilder: xml2js.Builder;

  private xmlParserIgnoreAttrs?: xml2js.Parser;

  private xmlParser?: xml2js.Parser;

  private defaultIgnoreAttrs?: boolean;


  /**
   * XML parser options
   */
  private xmlParserOptions: xml2js.ParserOptions = {
    // Trim the whitespace at the beginning and end of text nodes
    trim: true,
    // Always put child nodes in an array if true; otherwise an array is created only if there is more than one
    explicitArray: false,
    // Ignore all XML attributes and only create text nodes
    ignoreAttrs: false,
    // Attribute value processing functions
    attrValueProcessors: [xml2js.processors.parseNumbers],
    // Element value processing functions
    valueProcessors: [xml2js.processors.parseNumbers],
  };

  /**
   * XML builder options
   */
  private xmlBuilderOptions: xml2js.BuilderOptions = {
    // Omit the XML header?
    headless: false,
  };

  private helloDataSubject$ = new BehaviorSubject<HelloResult | null>(null);

  /**
   * Subject that stores and emits the netconf channel.
   * The value is undefined until the channel is ready.
   * The value is null if the channel is closed.
   */
  private netconfChannelSubject$? = new BehaviorSubject<ClientChannelState>({ state: 'uninitialized' });

  /** Time in milliseconds to wait for the server, see NetconfParams.timeout */
  private readonly timeout: number;

  /**
   * The error that closed the connection, stored by handleError.
   * The connection subject itself is never put into the error state, otherwise
   * getValue() would rethrow it and every later request would replay it.
   */
  private channelError?: Error;

  private netconfChannel$: Observable<ClientChannelState> = of(null).pipe(
    switchMap(() => {
      if(!this.netconfChannelSubject$){
        this.debug('netconfChannelSubject$ is undefined', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
        return throwError(() => new Error('Trying to use connection that was already closed'));
      }
      if(this.netconfChannelSubject$.getValue().state === 'closed'){
        this.debug('netconfChannelSubject$ is closed', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
        return throwError(() => new Error('Trying to use connection that was closed after an error'));
      }
      if(this.netconfChannelSubject$.getValue().state === 'uninitialized'){
        if(this.params.pass === undefined && !this.params.privateKey && !this.params.agent){
          return throwError(() => new Error('No authentication method provided: set pass, privateKey or agent'));
        }
        this.debug(`Opening connection to ${this.params.user}@${this.params.host}:${this.params.port}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
        this.netconfChannelSubject$.next({ state: 'connecting' });

        this.debug('Opening SSH session', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);

        this.sshClient = new Client();

        this.sshClient.on('ready',   this.sshReadyEvent);
        this.sshClient.on('error',   this.sshErrorEvent);
        this.sshClient.on('timeout', this.sshTimeoutEvent);
        this.sshClient.on('close',   this.sshCloseEvent);

        try{
          this.sshClient.connect({
            host: this.params.host,
            username: this.params.user,
            port: this.params.port,
            password: this.params.pass,
            privateKey: this.params.privateKey,
            passphrase: this.params.passphrase,
            agent: this.params.agent,
            readyTimeout: this.timeout,
            debug: (message: string): void => this.debug(message, SSH_DEBUG_TAG, SSH_DEBUG_LEVEL),
          });
        }catch(err){
          // connect() validates the configuration synchronously and throws, for example, when the
          // private key cannot be parsed. Report it through the usual error path so that the client
          // is not left in the 'connecting' state.
          this.handleError(err as Error);
        }
      }
      return this.netconfChannelSubject$.asObservable().pipe(
        filter(Boolean),
        // Fail the requests that are in flight when the connection breaks
        map((channelState: ClientChannelState) => {
          if(channelState.state === 'closed'){
            throw this.channelError ?? new Error('Netconf connection closed');
          }
          return channelState;
        }),
      );
    }),
  );

  /**
   * @param {NetconfParams} params - Netconf client parameters
   */
  public constructor(params: NetconfParams) {
    this.params = params;
    this.timeout = this.params.timeout ?? SSH_TIMEOUT;
    this.defaultIgnoreAttrs = this.params.ignoreAttrs;
    this.xmlBuilder = new xml2js.Builder(this.xmlBuilderOptions);
    // this.xmlParser = new xml2js.Parser(this.xmlParserOptions);
  }

  /**
   * Close the Netconf channel and SSH connection.
   */
  public close(): Observable<void> {
    if (!this.netconfChannelSubject$){
      return throwError(() => new Error('Trying to close connection that was already closed'));
    }
    if (this.netconfChannelSubject$.getValue().state === 'uninitialized') {
      return throwError(() => new Error('Trying to close connection that was not opened'));
    }
    if (this.netconfChannelSubject$.getValue().state === 'closed') {
      // handleError already destroyed the channel and the ssh session
      this.debug('Closing connection that was closed after an error', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
      this.netconfChannelSubject$.complete();
      this.netconfChannelSubject$ = undefined;
      return of(void 0);
    }
    // Get the Netconf channel from observable (replayed value)
    return this.netconfChannel$.pipe(
      take(1),
      // If timeout or error => no channel to close
      timeout({
        each: 1000,
        with: () => of(null).pipe(
          tap(() => {
            this.debug('Timeout waiting for Netconf channel when closing it', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          }),
        ),
      }),
      catchError((error: Error) => {
        this.debug(`Error getting Netconf channel while closing connection: ${error.message}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
        return of(null);
      }),
      // If channel opened, close it
      switchMap((channelState: ClientChannelState | null): Observable<void> => {
        if(!channelState){
          this.netconfChannelSubject$?.complete();
          this.netconfChannelSubject$ = undefined;
          return of(void 0);
        }
        switch(channelState.state){
        case 'uninitialized':
          this.debug('Trying to close Netconf channel that was not initialized', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          return throwError(() => new Error('Trying to close Netconf channel that was not initialized'));
        case 'connecting':
          this.debug('Closing Netconf channel that is being connected', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          this.netconfChannelSubject$?.complete();
          this.netconfChannelSubject$ = undefined;
          return of(void 0);
        case 'closed':
          this.debug('Closing Netconf channel that was closed after an error', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          this.netconfChannelSubject$?.complete();
          this.netconfChannelSubject$ = undefined;
          return of(void 0);
        case 'ready':
        default:
          this.debug('Closing Netconf channel, sending close-session', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          return this.sendCloseSession(channelState.channel).pipe(
            catchError((error: Error) => {
              this.debug(`Error sending close-session: ${error.message}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
              return of(void 0);
            }),
            tap(() => {
              this.debug('Netconf channel closed', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
              this.netconfChannelSubject$?.getValue().channel?.removeAllListeners('close');
              this.netconfChannelSubject$?.getValue().channel?.destroy();
              this.netconfChannelSubject$?.complete();
              this.netconfChannelSubject$ = undefined;
            }),
            // switchMap(() => channelClosed$),
            take(1),
            timeout({
              each: this.timeout,
              with: () => of(void 0),
            }),
            map(() =>  void 0),
            catchError((error: Error) => {
              this.debug(`Error closing Netconf channel: ${error.message}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
              return of(void 0);
            }),
          );
        }
      }),
      switchMap((): Observable<void> => {
        if(!this.sshClient){
          this.debug('No SSH session to close', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          return of(void 0);
        }
        this.debug('Closing SSH session', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
        const sessionClosed$ = new Subject<void>();
        const sessionClosedEvent = (): void => {
          this.sshClient?.removeAllListeners('close');
          this.sshClient?.removeAllListeners('error');
          this.sshClient?.removeAllListeners('timeout');
          this.sshClient?.destroy();
          this.sshClient = undefined;
          this.debug('SSH session closed', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          sessionClosed$.next();
          sessionClosed$.complete();
        };
        this.sshClient.removeListener('close', this.sshCloseEvent);
        this.sshClient.on('close', sessionClosedEvent);
        this.sshClient.end();
        return sessionClosed$.pipe(
          take(1),
          catchError((error: Error) => {
            sessionClosedEvent();
            this.debug(`Error closing SSH session: ${error.message}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
            return of(void 0);
          }),
          timeout({
            each: this.timeout,
            with: () => {
              sessionClosedEvent();
              return throwError(() => new Error('Timeout closing SSH session'));
            },
          }),
        );
      }),
      finalize(() => {
        this.debug('Connection closed', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
      }),
    );
  }


  /**
   * Observable that emits the hello message or an error
   */
  public hello(): Observable<HelloResult> {
    if(!this.netconfChannelSubject$){
      return throwError(() => new Error('Requesting HELLO on a closed connection'));
    }
    return merge(
      // Error stream - completes when hello data arrives
      this.netconfChannel$.pipe(
        takeUntil(this.helloDataSubject$.pipe(filter(Boolean))),
        switchMap(() => NEVER),
      ),
      // Hello data stream
      this.helloDataSubject$.pipe(
        filter(Boolean),
      ),
    ).pipe(
      take(1),
      finalize(() => {
        this.debug('Finalize Hello data stream', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
      }),
    );
  }

  /**
   * Send a netconf RPC request.
   *
   * Send a request and wait for a response. The first response is emitted and the observable completes.
   *
   * @param {NetconfObjType} request - The netconf request object
   * @returns {Observable<NetconfData>} An observable that emits the response
   */
  protected rpcExec(request: NetconfType, ignoreAttrs?: boolean): Observable<RpcReply> {
    return this.sendRequest(request, undefined, ignoreAttrs);
  }

  /**
   * Send a request and wait for notifications. The returned observable will continue to emit
   * notifications as they are received. Used for subscriptions.
   *
   * @param {NetconfObjType} request - The netconf request object
   * @param {Observable<void>} stop$ - An observable that emits when the request should be stopped
   * @returns {Observable<NetconfData>} An observable that emits the response
   */
  protected rpcStream(
    request: CreateSubscriptionRequest,
    stop$?: Subject<void>
  ): Observable<NotificationResult | RpcReply> {
    return this.sendRequest(request, stop$).pipe(
      // Check if result is OK
      tap((data: RpcReply) => {
        if(data.result?.hasOwnProperty('rpc-reply')){
          const rpcReply = data.result;
          if(!rpcReply['rpc-reply']?.hasOwnProperty('ok')){
            throw new Error('Did not receive rpc-reply/ok in response to subscription');
          }
        }
      }),
    );
  }

  protected debug(message: string, tag: string, level?: number): void {
    if(this.params.debug){
      this.params.debug(`${tag}: ${message}`, level ?? NETCONF_DEBUG_LEVEL);
    }
  }

  /**
   * Send a netconf request and return an observable that emits the response(s).
   *
   * @param {NetconfObjType} request - The netconf request object
   * @param {Observable<void>} stop$ - Controls the subscription behavior:
   *   - If undefined: Single-response mode. Emits first server response and completes immediately after.
   *   - If provided: Subscription mode. Continuously emits notifications from server and completes when stop$ emits.
   * @returns {Observable<NetconfData>} Server response(s):
   *   - Single response in single-response mode
   *   - Stream of notifications in subscription mode
   */
  private sendRequest(request: NetconfType, stop$?: Subject<void>, ignoreAttrs?: boolean): Observable<RpcReply> {
    return of(null).pipe(
      map(() => {
        const messageId = this.idCounter += 1;
        const object: SafeAny = {};
        object.rpc = request;
        if (!object.rpc.$) object.rpc.$ = {};
        object.rpc.$['message-id'] = messageId;
        object.rpc.$.xmlns = 'urn:ietf:params:xml:ns:netconf:base:1.0';
        return [messageId, this.xmlBuilder.buildObject(object)] as [number, string];
      }),
      map(([messageId, xml]) => [messageId, `${xml}\n${NETCONF_DELIM}`] as [number, string]),
      switchMap(([messageId, xml]) => this.sendXml(xml, messageId, stop$, ignoreAttrs)),
      // Timeout only for the first request. All subsequent requests (in case of awaitNotifications) are notifications
      // and can be received for a long time.
      // A missing reply means the session is unusable, so tear it down. Errors reported by the server
      // (rpc-error) or raised while parsing a reply fail only this request, the connection stays usable.
      timeout({
        first: this.timeout,
        with: () => {
          const err = new Error('Timeout sending request');
          this.handleError(err);
          return throwError(() => err);
        },
      }),
    );
  }

  private sendXml(xml: string, messageId: number, stop$?: Subject<void>, ignoreAttrs?: boolean): Observable<RpcReply> {
    if(!this.netconfChannelSubject$){
      return throwError(() => new Error('Requesting data on a closed connection'));
    }
    const rcvBuffer = new NetconfBuffer();
    const replySubject = new Subject<RpcReply>();
    let replyReceived = false;

    const rpcReplyRegexp = new RegExp(`<rpc-reply.*message-id="${messageId}"[\\s\\S]*</rpc-reply>`);

    const dataEventHandler = (data: Buffer): void => {
      this.debug(`Data received (expecting rpc-reply), len=${data.length}`, NETCONF_DEBUG_TAG, NETCONF_DATA_DEBUG_LEVEL);
      if(!rcvBuffer.append(data)) {
        rcvBuffer.clear();
        replySubject.complete();
        this.handleError(new Error('Netconf message too large'));
        return;
      }
      let message: string | undefined;
      while((message = rcvBuffer.extract()) !== undefined){
        this.debug(message, NETCONF_DATA_DEBUG_RECV_TAG, NETCONF_DATA_DEBUG_LEVEL);
        if(
          (!replyReceived && rpcReplyRegexp.test(message))
          || (replyReceived && stop$ && NOTIFICATION_REGEXP.test(message))
        ){
          if(!replyReceived){
            this.debug(`Received reply, message-id=${messageId}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          }else{
            this.debug('Received notification', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          }

          replyReceived = true;

          this.parseXml(message, ignoreAttrs).subscribe({
            next: ({parsed, original}) => {
              replySubject.next({ xml: original, result: parsed as { 'rpc-reply': RpcReplyType } });
              if(!stop$){
                replySubject.complete();
              }else{
                this.debug('Waiting for notifications', NETCONF_DEBUG_TAG, NETCONF_DATA_DEBUG_LEVEL);
              }
            },
            // Fail this request only, the connection stays usable
            error: (err: Error) => {
              this.debug(`Request failed, message-id=${messageId}: ${err.message}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
              replySubject.error(err);
            },
          });
          if(!stop$){
            break;
          }
        }
      }
    };

    return combineLatest([
      // Error stream - completes when hello data arrives
      this.netconfChannel$.pipe(
        takeUntil(replySubject),
        filter(channelState => channelState.state === 'ready'),
        tap((channelState: ClientChannelState) => {
          this.debug(`Sending request, message-id=${messageId}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          this.debug(xml, NETCONF_DATA_DEBUG_SEND_TAG, NETCONF_DATA_DEBUG_LEVEL);
          channelState.channel?.write(xml, () => channelState.channel?.on('data', dataEventHandler));
        }),
      ),
      // Data stream
      replySubject,
    ]).pipe(
      takeUntil(stop$?.pipe(
        tap(() => {
          this.debug(`Removing data event listener for message-id=${messageId}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          this.netconfChannelSubject$?.getValue().channel?.removeListener('data', dataEventHandler);
          rcvBuffer.clear();
          replySubject.complete();
        })
      ) ?? NEVER),
      map(([channelState, data]) => {
        if(!stop$){
          this.debug(`Removing data event listener for message-id=${messageId}`, NETCONF_DEBUG_TAG, NETCONF_DATA_DEBUG_LEVEL);
          channelState.channel?.removeListener('data', dataEventHandler);
          rcvBuffer.clear();
        }
        return data;
      }),
      // The request can also end without reaching the map above (error or unsubscribe)
      finalize(() => {
        this.netconfChannelSubject$?.getValue().channel?.removeListener('data', dataEventHandler);
        rcvBuffer.clear();
      }),
    );
  }

  /**
   * Handles the ssh ready event from the ssh lib. Event is sent by the ssh lib when the connection is ready,
   * but not the netconf channel yet.
   */
  private sshReadyEvent = (): void => {
    this.debug('SSH session ready', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
    this.debug('Opening Netconf channel', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
    this.sshClient?.subsys('netconf', this.channelReady);
    timer(this.timeout).pipe(
      takeUntil(this.helloDataSubject$.pipe(filter(Boolean))),
    ).subscribe(() => {
      this.debug('Timeout waiting for HELLO', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
      this.handleError(new Error('Netconf HELLO not received'));
    });
  };

  /**
   * Handles the ssh error event from the ssh lib.
   *
   * @param {Error} err - The error event
   */
  private sshErrorEvent = (err: Error): void => {
    this.debug(`SSH session error: ${err.message}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
    this.handleError(err);
  };

  /**
   * Handles the ssh timeout event from the ssh lib.
   */
  private sshTimeoutEvent = (): void => {
    this.debug('SSH session timeout', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
    this.handleError(new Error('SSH timeout'));
  };

  /**
   * Handles the ssh close event. Event is sent by the ssh lib when the connection is closed.
   */
  private sshCloseEvent = (): void => {
    this.debug('SSH session closed unexpectedly', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
    this.handleError(new Error('SSH session closed unexpectedly'));
  };

  /** Clean up on error and send the error to the connection subject */
  private handleError(err: Error): void {
    if(this.netconfChannelSubject$?.getValue().state === 'closed'){
      // Already torn down by an earlier error, do not clean up or report twice
      this.debug(`Ignoring error on a closed connection: ${err.message}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
      return;
    }
    const channel = this.netconfChannelSubject$?.getValue().channel;
    if(channel){
      channel.removeAllListeners('close');
      channel.removeAllListeners('error');
      channel.destroy();
    }
    if(this.sshClient){
      this.sshClient.removeAllListeners('error');
      this.sshClient.removeAllListeners('timeout');
      this.sshClient.removeAllListeners('close');
      this.sshClient.destroy();
    }
    this.channelError = err;
    this.netconfChannelSubject$?.next({ state: 'closed' });
  }

  /**
   * Handles the channel ready event. Event is sent by the ssh lib when the Netconf channel is ready.
   *
   * @param {Error | undefined} err - The error event
   * @param {ClientChannel} channel - The opened channel (Netconf)
   */
  private channelReady = (err: Error | undefined, channel: ClientChannel): void => {
    if (err) {
      this.debug(`Netconf channel error: ${err.message}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
      this.handleError(err);
      return;
    }

    this.debug('Netconf channel ready', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);

    const rcvBuffer = new NetconfBuffer();

    const cleanup = (): void => {
      channel.removeListener('data', helloListener);
      channel.removeListener('close', closeListener);
      channel.removeListener('error', errorListener);
      rcvBuffer.clear();
    };

    const helloListener = (chunk: Buffer): void => {
      this.channelHelloEvent(channel, chunk, rcvBuffer, helloListener);
    };

    const closeListener = (): void => {
      this.debug('Netconf channel closed unexpectedly', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
      cleanup();
      this.handleError(new Error('Netconf channel closed unexpectedly'));
    };

    const errorListener = (error: Error): void => {
      this.debug(`Netconf channel error: ${error.message}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
      cleanup();
      this.handleError(error);
    };

    channel.on('data', helloListener);
    channel.on('error', errorListener);
    channel.on('close', closeListener);

    // timer(NETCONF_HELLO_TIMEOUT).pipe(
    //   takeUntil(this.helloDataSubject$.pipe(filter(Boolean))),
    // ).subscribe(() => {
    //   this.debug('Timeout waiting for HELLO', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
    //   channel.removeListener('data', helloListener);
    //   channel.removeListener('error', errorListener);
    //   channel.removeListener('close', closeListener);
    //   this.handleError(new Error('Netconf HELLO not received'));
    // });

    this.sendHello(channel);
  };

  /**
   * Sends the hello message to the netconf server.
   */
  private sendHello(channel: ClientChannel): void {
    const message = {
      hello: {
        $: {
          xmlns: 'urn:ietf:params:xml:ns:netconf:base:1.0',
        },
        capabilities: {
          capability: ['urn:ietf:params:xml:ns:netconf:base:1.0', 'urn:ietf:params:netconf:base:1.0'],
        },
      },
    };
    const xml = `${this.xmlBuilder.buildObject(message)}\n${NETCONF_DELIM}`;
    this.debug(xml, NETCONF_DATA_DEBUG_SEND_TAG, NETCONF_HELLO_DEBUG_LEVEL);
    channel.write(xml);
  }

  /**
   * Handles the first data event from the netconf channel.
   * The first (or few first - depending on the number of chunks) data event is the hello message.
   *
   * @param {ClientChannel} channel - The netconf channel
   * @param {Buffer} chunk - The chunk of data received from the netconf channel
   * @param {Buffer} rcvBuffer - The buffer to store the received data
   * @param {Function} helloListenerRef - The reference to the wrapper data listener function
   */
  private channelHelloEvent(
    channel: ClientChannel,
    chunk: Buffer,
    rcvBuffer: NetconfBuffer,
    helloListenerRef: (chunk: Buffer) => void,
  ): void {
    this.debug(`Data received (expecting hello), length=${chunk.length}`, NETCONF_DEBUG_TAG, NETCONF_DATA_DEBUG_LEVEL);

    if (!rcvBuffer.append(chunk)) {
      rcvBuffer.clear();
      channel.removeAllListeners();
      channel.destroy();
      this.handleError(new Error('Netconf message too large'));
      return;
    }

    let message: string | undefined;
    while ((message = rcvBuffer.extract()) !== undefined) {
      this.debug(message, NETCONF_DATA_DEBUG_RECV_TAG, NETCONF_HELLO_DEBUG_LEVEL);

      this.parseXml(message).subscribe({
        next: ({parsed, original}) => {
          if (parsed.hasOwnProperty('hello') && parsed.hello?.hasOwnProperty('session-id')) {
            const hello = parsed as HelloType;
            this.debug(`HELLO received, Netconf session ID: ${hello.hello['session-id']}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
            rcvBuffer.clear();
            if(this.netconfChannelSubject$?.getValue().state !== 'ready'){
              this.debug('Connection ready', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
              this.netconfChannelSubject$?.next({ state: 'ready', channel });
              this.helloDataSubject$.next({ xml: original, result: hello });
            }
            channel.removeListener('data', helloListenerRef);
          }
        },
        error: (err: Error) => {
          this.debug(`Error parsing HELLO response: ${err.message}`, NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          rcvBuffer.clear();
          channel.removeAllListeners();
          channel.destroy();
          this.handleError(err);
        },
      });
    }
  }

  private sendCloseSession(channel: ClientChannel): Observable<RpcResult> {
    channel.removeAllListeners('close');
    return this.sendRequest({
      'close-session': {
        $: { xmlns: 'urn:ietf:params:xml:ns:netconf:base:1.0' },
      },
    });
  }

  /**
   * Converts Netconf XML response into a NetconfType object
   *
   * @param  {string} xml - XML string to parse
   * @return {Observable<NetconfType>} Observable that emits the object parsed from the XML
   */
  private parseXml(xml: string, ignoreAttrs?: boolean): Observable<{parsed: NetconfType, original: string}> {
    if(ignoreAttrs === undefined){
      ignoreAttrs = this.defaultIgnoreAttrs;
    }
    let xmlParser;
    if(ignoreAttrs){
      if(!this.xmlParserIgnoreAttrs){
        this.xmlParserIgnoreAttrs = new xml2js.Parser({...this.xmlParserOptions, ignoreAttrs: true});
      }
      xmlParser = this.xmlParserIgnoreAttrs;
    }else{
      if(!this.xmlParser){
        this.xmlParser = new xml2js.Parser({...this.xmlParserOptions, ignoreAttrs: false});
      }
      xmlParser = this.xmlParser;
    }

    return from(xmlParser.parseStringPromise(xml)).pipe(
      map(reply => {
        // check if there is an error in the rpc reply
        if(reply.hasOwnProperty('rpc-reply')) {
          const errorMessage = this.hasError(reply['rpc-reply']);
          if(errorMessage) {
            throw new Error(`Netconf RPC error: ${errorMessage}`);
          }
        }
        return {parsed: reply, original: xml};
      }),
    );
  }

  /**
   * Checks if the rpc reply has an error and returns the error message
   *
   * @param rpcReply - The rpc reply to check
   * @returns The error message if there is an error, otherwise undefined
   */
  private hasError(rpcReply: NetconfType): string | undefined {
    const rpcError = rpcReply['rpc-error'] as RpcErrorType;
    if (!rpcError) return undefined;

    const errorMessage = rpcError['error-message'];

    if(typeof errorMessage === 'object'){
      return errorMessage?._ ?? rpcError['error-tag'];
    }else if(typeof errorMessage === 'string'){
      return errorMessage;
    }else{
      switch (rpcError['error-tag']) {
      case 'unknown-element':
        return `Unknown element: "${rpcError['error-info']?.['bad-element'] ?? ''}". Do you need to provide a namespace?`;
      case 'unknown-namespace':
        return `Unknown namespace: "${rpcError['error-info']?.['bad-namespace'] ?? ''}"`;
      case 'data-exists':
        return `Trying to create data that already exists (element "${rpcError['error-info']?.['bad-element'] ?? ''}")`;
      default:
        return rpcError['error-tag'];
      }
    }
  }
}