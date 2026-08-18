#!/usr/bin/env node

import { firstValueFrom, NEVER, Observable, of, Subject, timer } from 'rxjs';
import { defaultIfEmpty, filter, map, switchMap, takeUntil, tap } from 'rxjs/operators';
import { Netconf, NetconfType, NotificationResult, Result, RpcResult, SSH_TIMEOUT } from '../lib/index.ts';
import { catchMultipleEditError, setEditConfigStatus, setRpcConfigStatus, writeData } from './output-operators.ts';
import { Output } from './output.ts';
import { CliOptions, OperationType, parseArgs } from './parse-args.ts';
import { resolveXPath } from './resolve-xpath.ts';

/**
 * Execute the requested netconf operation
 *
 * @param client - The netconf client
 * @param cliOptions - The parsed command line arguments
 * @returns An observable that emits when the operation is complete
 */
function execNetconfOperation(client: Netconf, cliOptions: CliOptions): Observable<void>{
  Output.debug(`Performing operation: ${cliOptions.operation.type}`);
  switch(cliOptions.operation.type){
  case OperationType.HELLO:
    return client.hello().pipe(
      writeData(cliOptions.resultFormat),
      switchMap(() => client.close()),
    );

  case OperationType.GET:
    const getOptions = cliOptions.operation.options;
    return client.getData(getOptions.xpath, getOptions.configFilter).pipe(
      map(data => {
        let result: NetconfType | undefined;
        if (getOptions.fullTree){
          result = data.result;
        }else{
          // result = stripParents(data.result);
          result = resolveXPath(data.result, getOptions.xpath);
        }
        const isRootResult = data.result === result;
        data.result = result;
        return [data, isRootResult] as [Result, boolean];
      }),
      writeData(cliOptions.resultFormat),
      // writeData(cliOptions.resultFormat),
      switchMap(() => client.close()),
    );

  case OperationType.RPC:
    const rpcOptions = cliOptions.operation.options;
    return client.rpc(rpcOptions.cmd, rpcOptions.values ?? {}).pipe(
      setRpcConfigStatus(),
      writeData(cliOptions.resultFormat),
      switchMap(() => client.close()),
    );

  case OperationType.MERGE:
    const mergeOptions = cliOptions.operation.options;
    return client.editConfigMerge(mergeOptions.xpath, mergeOptions.values ?? {}).pipe(
      catchMultipleEditError(),
      setEditConfigStatus(),
      writeData(cliOptions.resultFormat),
      switchMap(() => client.connectionState === 'uninitialized' ? of(void 0) : client.close()),
    );

  case OperationType.CREATE: {
    const createOptions = cliOptions.operation.options;
    const operation = createOptions.editConfigValues?.type === 'keyvalue'
      ? client.editConfigCreate(createOptions.xpath, createOptions.editConfigValues.values, createOptions.beforeKey)
      : client.editConfigCreateListItems(createOptions.xpath, createOptions.editConfigValues.values);

    return operation.pipe(
      catchMultipleEditError(),
      setEditConfigStatus(),
      writeData(cliOptions.resultFormat),
      switchMap(() => client.connectionState === 'uninitialized' ? of(void 0) : client.close()),
    );
  }

  case OperationType.DELETE: {
    const deleteOptions = cliOptions.operation.options;
    const operation = deleteOptions.editConfigValues?.type === 'keyvalue'
      ? client.editConfigDelete(deleteOptions.xpath, deleteOptions.editConfigValues.values)
      : client.editConfigDeleteListItems(deleteOptions.xpath, deleteOptions.editConfigValues.values);

    return operation.pipe(
      catchMultipleEditError(),
      setEditConfigStatus(),
      writeData(cliOptions.resultFormat),
      switchMap(() => client.connectionState === 'uninitialized' ? of(void 0) : client.close()),
    );
  }

  case OperationType.REPLACE: {
    const replaceOptions = cliOptions.operation.options;
    const operation = replaceOptions.editConfigValues?.type === 'keyvalue'
      ? client.editConfigReplace(replaceOptions.xpath, replaceOptions.editConfigValues.values)
      : client.editConfigReplaceListItems(replaceOptions.xpath, replaceOptions.editConfigValues.values);

    return operation.pipe(
      catchMultipleEditError(),
      setEditConfigStatus(),
      writeData(cliOptions.resultFormat),
      switchMap(() => client.connectionState === 'uninitialized' ? of(void 0) : client.close()),
    );
  }

  case OperationType.SUBSCRIBE:
    const subscribeOptions = cliOptions.operation.options;
    const stop$ = new Subject<void>();
    const closed$ = new Subject<void>();
    process.on('SIGINT', async () => {
      Output.info('\nStopping subscription');
      stop$.next();
      stop$.complete();
      await firstValueFrom(timer(cliOptions.timeout ?? SSH_TIMEOUT).pipe(
        takeUntil(closed$),
        defaultIfEmpty(void 0),
      ));
    });
    return client.subscription(subscribeOptions.type === 'stream' ? {stream: subscribeOptions.stream} : {xpath: subscribeOptions.xpath}, stop$).pipe(
      filter((data: NotificationResult | RpcResult | undefined) => {
        if(data?.result?.hasOwnProperty('ok')){
          // This is a RPC Reply with OK, we skip it
          Output.info(`Started subscription. Ctrl+C to stop. PID=${process.pid}`);
          return false;
        }
        return true;
      }),
      switchMap(data => data ? of(data).pipe(writeData(cliOptions.resultFormat)) : of(data)),
      switchMap(data => data ? NEVER : client.close().pipe(
        tap(() => closed$.next()),
        tap(() => closed$.complete()),
      )),
    );

  default:
    throw new Error(`Invalid operation: ${cliOptions.operation.type}`);
  }
}

async function main(): Promise<void> {
  const cliOptions = await parseArgs();
  if (!cliOptions){
    return;
  }

  const showNamespaces = cliOptions.operation.type === OperationType.GET && cliOptions.operation.options.showNamespaces;
  const allowMultipleEdit = (
    cliOptions.operation.type === OperationType.MERGE
    || cliOptions.operation.type === OperationType.CREATE
    || cliOptions.operation.type === OperationType.DELETE
  ) && cliOptions.operation.options.allowMultiple;

  const client = new Netconf({
    host: cliOptions.host,
    port: cliOptions.port,
    user: cliOptions.user,
    pass: cliOptions.pass,
    privateKey: cliOptions.privateKey,
    passphrase: cliOptions.passphrase,
    agent: cliOptions.agent,
    timeout: cliOptions.timeout,
    ignoreAttrs: !showNamespaces,
    readOnly: cliOptions.readOnly,
    allowMultipleEdit,
    namespace: cliOptions.namespaces,
    debug: (msg: string, level: number) => Output.debug(msg, undefined, level),
  });

  await firstValueFrom(execNetconfOperation(client, cliOptions));
}

main().then(() => {
  Output.debug('Exit (success)');
}).catch((error: Error) => {
  Output.error(`${error.message}`);
  Output.printStackTrace(error);
  Output.debug('Exit (error)');
  process.exit(1);
});

// Export functions for testing
if(process.env.NODE_ENV === 'test'){
  module.exports = { writeData, catchMultipleEditError, setEditConfigStatus };
}
