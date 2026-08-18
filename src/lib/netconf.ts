import { catchError, endWith, map, MonoTypeOperatorFunction, Observable, of, Subject, switchMap, tap, throwError } from 'rxjs';
import { NetconfBuildConfig } from './netconf-build-config.ts';
import { NetconfClient } from './netconf-client.ts';
import { CreateSubscriptionRequest, EditConfigResult, GetDataResult, GetDataResultType, MultipleEditError, NetconfParams, NetconfPrimitiveType, NetconfType, NotificationResult, RpcReply, RpcReplyType, RpcResult, SafeAny, SubscriptionOption } from './netconf-types.ts';

const NETCONF_DEBUG_LEVEL = 1;
const NETCONF_DEBUG_TAG = 'NETCONF';

/**
 * Netconf client
 */
export class Netconf extends NetconfClient{
  /**
   * Class constructor
   *
   * @param {NetconfParams} params - Netconf client parameters
   */
  public constructor(params: NetconfParams) {
    super(params);
  }

  /**
   * Execute a custom RPC operation. Example:
   *
   * ```typescript
   * const netconf = new Netconf({
   *   host: '127.0.0.1',
   *   port: 2022,
   *   user: 'admin',
   *   pass: 'admin',
   *   namespace: 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring',
   * });
   * netconf.rpc('/get-schema', { identifier: 'ietf-netconf' }).subscribe({
   *   next: (data) => {
   *     console.log(data);
   *   },
   *   error: (error) => {
   *     console.error(error);
   *   },
   * });
   * ```
   *
   * @param {string} xpath - RPC command formatted as XPath
   * @param {NetconfType} values - Object of key-value pairs to be sent with the RPC request. The object may have
   *   nested objects and arrays.
   * @returns {Observable<RpcResult>} Observable of the result
   */
  public rpc(xpath: string, values: NetconfType): Observable<RpcResult> {
    xpath=xpath.trim();
    if(xpath==='' || xpath === '/' || xpath === '//'){
      return throwError(() => new Error('XPath for rpc config must contain at least one element'));
    }

    const targetObj: NetconfType = {};
    return new NetconfBuildConfig(xpath, undefined, this.params.namespace).build(targetObj).pipe(
      this.checkMultipleEdit(),
      tap((configObj: NetconfType[]) => {
        configObj.forEach((o: NetconfType) => {
          Object.assign(o, values);
        });
      }),
      switchMap(() => {
        if(this.params.readOnly){
          this.debug('Read-only mode. Would send the following request to the server:', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          this.debug(JSON.stringify(targetObj, null, 2), NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
          throw new Error('Operation not performed: in read-only mode');
        }else{
          return this.rpcExec(targetObj);
        }
      }),
      map((data: RpcReply) => ({
        xml: data.xml,
        result: data.result?.['rpc-reply'],
      })),
    );
  }

  /**
   * Get items from the Netconf server using `get-data` or `get` RPC
   *
   * @param {string} xpath - XPath filter of the configuration object,
   *   for example, //aaa//user[name="admin"]
   * @param {GetDataResultType} resultType Result type (config filter)
   *   - If 'config', only the configuration is returned
   *   - If 'state', only the state data is returned
   *   - If 'schema', only the shallow subtree for the XPath is returned (object with keys only), no descendants
   *   - If undefined, both config and state data are returned
   * @returns {Observable<GetDataResult>} Observable of the result
   */
  public getData(xpath: string, resultType?: GetDataResultType): Observable<GetDataResult> {
    let request;
    switch(resultType) {
    case GetDataResultType.SCHEMA:
      request = {
        'get-data': {
          $: {
            xmlns: 'urn:ietf:params:xml:ns:yang:ietf-netconf-nmda',
            'xmlns:ds': 'urn:ietf:params:xml:ns:yang:ietf-datastores',
          },
          datastore: 'ds:operational',
          'xpath-filter': xpath,
          'max-depth': 1,
        },
      };
      break;

    case GetDataResultType.CONFIG:
    case GetDataResultType.STATE:
      // ConfD specific get-data RPC (part of ConfD's tailf namespace)
      request = {
        'get-data': {
          $: {
            xmlns: 'urn:ietf:params:xml:ns:yang:ietf-netconf-nmda',
            'xmlns:ds': 'urn:ietf:params:xml:ns:yang:ietf-datastores',
          },
          datastore: 'ds:operational',
          'xpath-filter': xpath,
          'with-defaults': 'report-all',
          'config-filter': resultType === GetDataResultType.CONFIG ? true : false,
        },
      };
      break;

    // If undefined, both config and state data are returned
    default:
      // Standard NETCONF operation, retrieves both config and state data
      request = {
        get: {
          $: {
            xmlns: 'urn:ietf:params:xml:ns:netconf:base:1.0',
          },
          'with-defaults': {
            $: {
              xmlns: 'urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults',
            },
            _: 'report-all',
          },
          filter: {
            $: {
              type: 'xpath',
              select: xpath,
            },
          },
        },
        // Also possible to use `get-data` RPC:
        // 'get-data': {
        //   $: {
        //     xmlns: 'urn:ietf:params:xml:ns:yang:ietf-netconf-nmda',
        //     'xmlns:ds': 'urn:ietf:params:xml:ns:yang:ietf-datastores',
        //   },
        //   datastore: 'ds:operational',
        //   'xpath-filter': xpath,
        //   'with-defaults': 'report-all',
        // },
      };
      break;
    }

    return this.rpcExec(request, resultType === GetDataResultType.SCHEMA? false : undefined).pipe(
      map((data: RpcResult): GetDataResult => {
        const ret: GetDataResult = {
          xml: data.xml,
          result: data.result,
        };
        if (!data.result?.hasOwnProperty('rpc-reply')){
          ret.result = undefined;
          return ret;
        }
        const rpcReply = data.result?.['rpc-reply'] as RpcReplyType;
        ret.result = rpcReply.data;
        if(resultType === GetDataResultType.SCHEMA && ret.result?.hasOwnProperty('$')){
          delete (ret.result as SafeAny).$;
        }
        return ret;
      })
    );
  }

  /**
   * Edit the configuration using `edit-config` RPC and merge operation
   *
   * @param {string} xpath XPath filter of the configuration object,
   *   for example, `/aaa/authentication/users/user[name="admin"]`
   * @param {NetconfType} values New config object - a key-value pair object that can have
   *   nested objects, for example `{homedir: '/home/admin'}`
   * @returns {Observable<EditConfigResult>} Observable of the result
   */
  public editConfigMerge(xpath: string, values: NetconfType): Observable<EditConfigResult> {
    const schema = this.fetchSchema(xpath);
    const targetObj = {};

    return new NetconfBuildConfig(
      xpath,
      schema,
      this.params.namespace,
      this.guessNamespace(xpath)
    ).build(targetObj).pipe(
      this.checkMultipleEdit(),
      tap((configObj: NetconfType[]) => {
        configObj.forEach((o: NetconfType) => {
          Object.assign(o, values);
        });
      }),
      switchMap(() => this.editConfig(targetObj)),
    );
  }

  /**
   * Creates a leaf in the configuration specified by XPath filter.
   * Default operation is 'create', so if an item exists, confd will return error.
   * If beforeKey is specified, the item will be inserted before the specified item.
   *
   * @param {string} xpath XPath filter of the leaf where the item needs to be inserted
   *     for example,  /aaa/authentication/users/user
   * @param {NetconfType} values New item config, for example {name: 'admin', homedir: '/home/admin'}
   * @param {string} beforeKey If specified, the item will be inserted before the item specified by this key
   *     for example, '[name="oper"]'
   * @returns {Observable<EditConfigResult>} Observable of the result
   */
  public editConfigCreate(
    xpath: string,
    values: NetconfType,
    beforeKey?: string
  ): Observable<EditConfigResult> {
    const targetObj = {};
    const schema = this.fetchSchema(xpath);

    return new NetconfBuildConfig(
      xpath,
      schema,
      this.params.namespace,
      this.guessNamespace(xpath)
    ).build(targetObj).pipe(
      this.checkMultipleEdit(),
      tap((configObj: NetconfType[]) => {
        configObj.forEach((o: NetconfType) => {
          Object.assign(o, values);
          o.$ = {
            ...o.$ ?? {} as SafeAny,
            'xmlns:nc': 'urn:ietf:params:xml:ns:netconf:base:1.0',
            'nc:operation': 'create',
          };
          if(beforeKey !== undefined){
            o.$ = {
              ...o.$ ?? {} as SafeAny,
              'xmlns:yang': 'urn:ietf:params:xml:ns:yang:1',
              'yang:insert': 'before',
              'yang:key': beforeKey,
            };
          }
        });
      }),
      switchMap(() => this.editConfig(targetObj)),
    );
  }

  /**
   * Creates a list item in the configuration.
   *
   * @param {string} xpath XPath filter of the object where the item needs to be created
   * @param {NetconfPrimitiveType[]} listItems List of items to create
   * @returns {Observable<EditConfigResult>} Observable of the result
   */
  public editConfigCreateListItems(xpath: string, listItems: NetconfPrimitiveType[]): Observable<EditConfigResult> {
    const targetObj = {};
    const schema = this.fetchSchema(xpath);

    return new NetconfBuildConfig(
      xpath,
      schema,
      this.params.namespace,
      this.guessNamespace(xpath)
    ).build(targetObj).pipe(
      this.checkMultipleEdit(),
      tap((configObj: NetconfType[]) => {
        configObj.forEach((o: NetconfType) => {
          // Traverse the targetObj to find the parent of o
          const foundParent = this.findParent(targetObj, o);
          if(foundParent === undefined){
            throw new Error('Failed to build the edit config message matching the XPath/Schema');
          }
          const parent = foundParent.parent;
          const index = foundParent.index;
          parent[index] = listItems.map((value: NetconfPrimitiveType) => ({
            $: {
              'xmlns:nc': 'urn:ietf:params:xml:ns:netconf:base:1.0',
              'nc:operation': 'create',
            },
            _: value,
          }));
        });
      }),
      switchMap(() => this.editConfig(targetObj)),
    );
  }

  /**
   * Deletes a leaf in the configuration. Leaf is specified by XPath filter.
   *
   * @param {string} xpath XPath filter of the leaf where the item needs to be deleted
   *     for example,  `/aaa/authentication/users/user`
   * @param {NetconfType} values object containing the leaf key, for example `{name: 'admin'}`
   * @returns {Observable<EditConfigResult>} Observable of the result
   */
  public editConfigDelete(xpath: string, values: NetconfType): Observable<EditConfigResult> {
    const targetObj = {};
    const schema = this.fetchSchema(xpath);

    return new NetconfBuildConfig(
      xpath,
      schema,
      this.params.namespace,
      this.guessNamespace(xpath)
    ).build(targetObj).pipe(
      this.checkMultipleEdit(),
      tap((configObj: NetconfType[]) => {
        configObj.forEach((o: NetconfType) => {
          Object.assign(o, values);
          o.$ = {
            ...o.$ ?? {} as SafeAny,
            'xmlns:nc': 'urn:ietf:params:xml:ns:netconf:base:1.0',
            'nc:operation': 'delete',
          };
        });
      }),
      switchMap(() => this.editConfig(targetObj)),
    );
  }

  /**
   * Deletes a list item in the configuration.
   *
   * @param {string} xpath XPath filter of the object where the item needs to be deleted
   * @param {NetconfPrimitiveType[]} listItems List of items to delete
   * @returns {Observable<EditConfigResult>} Observable of the result
   */
  public editConfigDeleteListItems(xpath: string, listItems: NetconfPrimitiveType[]): Observable<EditConfigResult> {
    const targetObj = {};
    const schema = this.fetchSchema(xpath);

    return new NetconfBuildConfig(
      xpath,
      schema,
      this.params.namespace,
      this.guessNamespace(xpath)
    ).build(targetObj).pipe(
      this.checkMultipleEdit(),
      tap((configObj: NetconfType[]) => {
        configObj.forEach((o: NetconfType) => {
          const foundParent = this.findParent(targetObj, o);
          if(foundParent === undefined){
            throw new Error('Failed to build the edit config message matching the XPath/Schema');
          }
          const parent = foundParent.parent;
          const index = foundParent.index;
          parent[index] = listItems.map((value: NetconfPrimitiveType) => ({
            $: {
              'xmlns:nc': 'urn:ietf:params:xml:ns:netconf:base:1.0',
              'nc:operation': 'delete',
            },
            _: value,
          }));
        });
      }),
      switchMap(() => this.editConfig(targetObj)),
    );
  }

  /**
   * Replaces a leaf in the configuration. Leaf is specified by XPath filter.
   *
   * @param {string} xpath XPath filter of the leaf where the item needs to be replaced
   *     for example,  `/aaa/authentication/users/user`
   * @param {NetconfType} values object containing the leaf key, for example `{name: 'admin'}`
   * @returns {Observable<EditConfigResult>} Observable of the result
   */
  public editConfigReplace(xpath: string, values: NetconfType): Observable<EditConfigResult> {
    const targetObj = {};
    const schema = this.fetchSchema(xpath);

    return new NetconfBuildConfig(
      xpath,
      schema,
      this.params.namespace,
      this.guessNamespace(xpath)
    ).build(targetObj).pipe(
      this.checkMultipleEdit(),
      tap((configObj: NetconfType[]) => {
        configObj.forEach((o: NetconfType) => {
          Object.assign(o, values);
          o.$ = {
            ...o.$ ?? {} as SafeAny,
            'xmlns:nc': 'urn:ietf:params:xml:ns:netconf:base:1.0',
            'nc:operation': 'replace',
          };
        });
      }),
      switchMap(() => this.editConfig(targetObj)),
    );
  }

  /**
   * Replaces a list item in the configuration.
   *
   * @param {string} xpath XPath filter of the object where the item needs to be replaced
   * @param {NetconfPrimitiveType[]} listItems List of items to replace
   * @returns {Observable<EditConfigResult>} Observable of the result
   */
  public editConfigReplaceListItems(xpath: string, listItems: NetconfPrimitiveType[]): Observable<EditConfigResult> {
    const targetObj = {};
    const schema = this.fetchSchema(xpath);

    return new NetconfBuildConfig(
      xpath,
      schema,
      this.params.namespace,
      this.guessNamespace(xpath)
    ).build(targetObj).pipe(
      this.checkMultipleEdit(),
      tap((configObj: NetconfType[]) => {
        configObj.forEach((o: NetconfType) => {
          const foundParent = this.findParent(targetObj, o);
          if(foundParent === undefined){
            throw new Error('Failed to build the edit config message matching the XPath/Schema');
          }
          const parent = foundParent.parent;
          const index = foundParent.index;
          parent[index] = listItems.map((value: NetconfPrimitiveType) => ({
            $: {
              'xmlns:nc': 'urn:ietf:params:xml:ns:netconf:base:1.0',
              'nc:operation': 'replace',
            },
            _: value,
          }));
        });
      }),
      switchMap(() => this.editConfig(targetObj)),
    );
  }

  /**
   * Commits the candidate datastore, applying the changes collected there to the running
   * configuration. Only meaningful when the client is configured with `datastore: 'candidate'`.
   * The server must advertise the :candidate capability.
   *
   * @returns {Observable<RpcResult>} Observable of the result
   */
  public commit(): Observable<RpcResult> {
    return this.rpcExecOk({ commit: null }, 'Commit');
  }

  /**
   * Discards the changes collected in the candidate datastore, reverting it to the contents of the
   * running configuration. The server must advertise the :candidate capability.
   *
   * @returns {Observable<RpcResult>} Observable of the result
   */
  public discardChanges(): Observable<RpcResult> {
    return this.rpcExecOk({ 'discard-changes': null }, 'Discard-changes');
  }

  /**
   * Creates a subscription to the Netconf server and returns an observable that emits notifications as they arrive.
   * See README for an example.
   *
   * @param {SubscriptionOption} option Subscription option - either xpath filter or stream name
   * @param {Subject<void>} stop$ A subject that should emit a value to stop the subscription
   * @returns {Observable<NotificationResult | RpcResult | undefined>} Observable of the result. Observable emits
   *   the following items in order:
   *   - `RpcResult` with the server's RPC response when the subscription is created
   *   - `NotificationResult` when a notification is received
   *   - `undefined` when the subscription is stopped
   */
  public subscription(
    option: SubscriptionOption, stop$?: Subject<void>
  ): Observable<NotificationResult | RpcResult | undefined> {
    let request: CreateSubscriptionRequest;
    if(typeof option === 'object' && 'xpath' in option){
      request = {
        'create-subscription': {
          $: {
            xmlns: 'urn:ietf:params:xml:ns:netconf:notification:1.0',
          },
          filter: {
            $: {
              type: 'xpath',
              select: option.xpath,
            },
          },
        },
      };
    }else if(typeof option === 'object' && 'stream' in option){
      request = {
        'create-subscription': {
          $: {
            xmlns: 'urn:ietf:params:xml:ns:netconf:notification:1.0',
          },
          stream: option.stream,
        },
      };
    }else{
      throw new Error('Invalid option in subscription');
    }
    return this.rpcStream(request, stop$).pipe(
      map((data: NotificationResult | RpcReply) => {
        if(data.result?.hasOwnProperty('rpc-reply')){
          const rpcResult: RpcResult = {
            xml: data.xml,
            result: data.result['rpc-reply'] as RpcReplyType,
          };
          return rpcResult;
        }
        return data;
      }),
      // When subscription is closed, emit undefined
      endWith(undefined),
    );
  }

  protected fetchSchema(xpath: string): Observable<RpcReplyType> {
    return this.getData(xpath, GetDataResultType.SCHEMA).pipe(
      map((data: GetDataResult) => {
        if(data.result === undefined){
          throw new Error('Failed to fetch element matching the XPath from the server. No element to update.');
        }
        return data.result;
      }),
    );
  }

  protected guessNamespace(xpath: string): Observable<string | undefined> {
    // get first XPath segment
    const firstSegment = xpath.trim().replace(/^\/\//, '/').split('/').find(x => x !== '');
    if(firstSegment === undefined){
      return of(undefined);
    }
    return this.getData(`/${firstSegment}`, GetDataResultType.SCHEMA).pipe(
      map((data: GetDataResult) => {
        const result = data.result as SafeAny;
        if(Object.keys(result).length === 1 && result[Object.keys(result)[0]]?.hasOwnProperty('$')){
          const $ = result[Object.keys(result)[0]]?.$;
          if($.hasOwnProperty('xmlns')){
            return $.xmlns;
          }
        }
        return undefined;
      }),
      catchError(() => of(undefined)),
    );
  }

  /**
   * Send a request that the server answers with a bare <ok/>, and check that confirmation.
   *
   * @param {NetconfType} request - The request to send
   * @param {string} operation - Name of the operation, used in the error messages
   * @returns {Observable<RpcResult>} Observable of the result
   */
  private rpcExecOk(request: NetconfType, operation: string): Observable<RpcResult> {
    if(this.params.readOnly){
      this.debug('Read-only mode. Would send the following request to the server:', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
      this.debug(JSON.stringify(request, null, 2), NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
      return throwError(() => new Error('Operation not performed: in read-only mode'));
    }

    return this.rpcExec(request).pipe(
      map((data: RpcReply): RpcResult => {
        if(!data.result?.hasOwnProperty('rpc-reply')){
          throw new Error(`${operation} operation failed: server response did not include rpc-reply`);
        }
        const reply = data.result['rpc-reply'];
        if(reply?.ok === undefined){
          throw new Error(`${operation} operation failed: server response did not include OK confirmation`);
        }
        return { xml: data.xml, result: reply };
      }),
    );
  }

  private editConfig(configObj: NetconfType): Observable<EditConfigResult>{
    const request = {
      'edit-config': {
        target: this.params.datastore === 'candidate' ? { candidate: null } : { running: null },
        config: configObj,
      },
    };

    if(this.params.readOnly){
      this.debug('Read-only mode. Would send the following request to the server:', NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
      this.debug(JSON.stringify(request, null, 2), NETCONF_DEBUG_TAG, NETCONF_DEBUG_LEVEL);
      throw new Error('Operation not performed: in read-only mode');
    }

    return this.rpcExec(request).pipe(
      map((data: RpcResult): EditConfigResult => {
        const ret: EditConfigResult = {
          xml: data.xml,
          result: data.result,
        };
        if (!data.result?.hasOwnProperty('rpc-reply')){
          throw new Error('Edit-config operation failed: server response did not include rpc-reply');
        }
        const result = data.result;
        if((result['rpc-reply'] as RpcReplyType)?.ok === undefined){
          throw new Error('Edit-config operation failed: server response did not include OK confirmation');
        }
        ret.result = result['rpc-reply'] as RpcReplyType;
        return ret;
      })
    );
  }

  private checkMultipleEdit(): MonoTypeOperatorFunction<NetconfType[]> {
    return tap((configObj: NetconfType[]) => {
      if(configObj.length === 0){
        // throw an error
        throw new Error('Failed to build the edit config message matching the XPath/Schema');
      }else if(configObj.length > 1 && !this.params.allowMultipleEdit){
        // throw an error
        throw new MultipleEditError();
      }
    });
  }

  /**
   * Given an object and one of its children, recursively traverse the object to find the parent of the given child
   * @param root - The root object
   * @param obj - The child object
   * @returns The child's parent object
   */
  // eslint-disable-next-line sonarjs/cognitive-complexity
  private findParent(root: NetconfType, obj: NetconfType): {parent: NetconfType, index: number | string} | undefined {
    if(Array.isArray(root)){
      for(let i=0; i<root.length; i++){
        if(root[i] === obj){
          return {parent: root, index: i};
        }
        const ret = this.findParent(root[i] as NetconfType, obj);
        if(ret) return ret;
      }
    }

    if(typeof root === 'object' && root !== null){
      for(const key of Object.keys(root)){
        if(root.hasOwnProperty(key)){
          if(root[key] === obj){
            return {parent: root, index: key};
          }
          const ret = this.findParent(root[key] as NetconfType, obj);
          if(ret) return ret;
        }
      }
    }
    return undefined;
  }
}
