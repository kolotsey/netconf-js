# JavaScript/TypeScript Netconf Client Library & CLI

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A pure TypeScript library for interacting with Netconf/ConfD servers. This client provides powerful and easy-to-use
API. Comes with an intuitive CLI tool for shell access and scripting.

**Note:** This README covers the Netconf library. For CLI tool usage,
see the [Netconf Console App](https://github.com/kolotsey/netconf-client/blob/main/CLI.md).

## Table of Contents

- [Description](#description)
- [Features](#features)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Usage Examples](#usage-examples)
  - [Get Data](#get-data)
  - [Edit Config (Merge)](#edit-config-merge)
  - [Custom RPC](#custom-rpc)
  - [Concurrency](#concurrency)
  - [Subscribe to Events](#subscribe-to-events)
- [API](#api)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Description

This project provides both a JavaScript/TypeScript Netconf client library and a user-friendly CLI for interacting
with Netconf servers. It supports XPath expressions (including wildcards) for **both reading and modifying** values,
making Netconf operations more straightforward and accessible.

## Features

- **TypeScript**: Written entirely in TypeScript.
- **RxJS**: Easy concurrency and error handling.
- **XPath**: Read and modify values using XPath expressions, including wildcards.
- **API**: Provides _get/get-data_, _edit-config_ (merge, create, delete, replace), _custom RPCs_, and _subscriptions_.
- **Server Response**: Library returns both parsed JavaScript objects and original XML responses.
- **CLI Tool**: For quick shell access and scripting.
See [Netconf Console App](https://github.com/kolotsey/netconf-client/blob/main/CLI.md).
- **Flexible Output**: CLI supports _JSON_, _XML_, _YAML_, _key-value_ (for easy scripting), and _tree_
(for easy viewing) output formats.

## Quick Start

Install the package:

```bash
npm install netconf-client
```

Basic usage example (substitute the host, port, username, and password with your own values):

```typescript
// quick-start.mjs

import { Netconf } from 'netconf-client';
import { firstValueFrom } from 'rxjs';

const netconf = new Netconf({ host: 'localhost', port: 2022, user: 'admin', pass: 'admin' });
const { result } = await firstValueFrom(netconf.getData('//aaa//user[name="admin"]'));
console.log(result);
await firstValueFrom(netconf.close());
```

Run the script:

```bash
node quick-start.mjs
```




## Installation

To use as a library in your project:

```bash
npm install netconf-client
```

## Usage Examples

The library can be used with both RxJS and Promises, so you can choose whichever style fits your project.
All examples from the README are also available in the [tests/readme-examples.ts](tests/readme-examples.ts) file.
It can be run with `npx tsx tests/readme-examples.ts` (provided npx is installed).

### Import the Library

```typescript
import { Netconf } from 'netconf-client';
```

### Get Data

Using promises:
```typescript
// Create a new Netconf instance
const netconf = new Netconf({host: 'localhost', port: 2022, user: 'admin', pass: 'admin'});
// Get the data from the server
const data = await firstValueFrom(netconf.getData('/confd-state/version'));
console.log((data.result as any)?.['confd-state'].version);
// Close the connection
await firstValueFrom(netconf.close());
```

Using RxJS:
```typescript
// Create a new Netconf instance
const netconf = new Netconf({host: 'localhost', port: 2022, user: 'admin', pass: 'admin'});
// Get the data from the server
netconf.getData('/confd-state/version').pipe(
  // Log the result
  tap(data => console.log((data.result as any)?.['confd-state'].version)),
  // Close the connection
  switchMap(() => netconf.close()),
).subscribe();
```

### Edit Config (Merge)

**Note:** provide the AAA namespace which is required for edit-config operation on AAA module. If not provided,
the library will attempt to determine the namespace by querying the server.

Using promises:
```typescript
const netconf = new Netconf({
  host: 'localhost',
  port: 2022,
  user: 'admin',
  pass: 'admin',
  // Provide the AAA namespace
  namespace: 'http://tail-f.com/ns/aaa/1.1',
});
try {
  await firstValueFrom(netconf.editConfigMerge('//aaa//user[name="admin"]', { password: 'admin' }));
  await firstValueFrom(netconf.close());
  console.log('Edit successful');
} catch (error) {
  console.error('Edit failed', error);
}
```

Using RxJS:
```typescript
const netconf = new Netconf({
  host: 'localhost',
  port: 2022,
  user: 'admin',
  pass: 'admin',
  // Provide the AAA namespace
  namespace: 'http://tail-f.com/ns/aaa/1.1',
});
netconf.editConfigMerge('//aaa//user[name="admin"]', { password: 'admin' }).pipe(
  tap(result => console.log('Edit status:', result.result)),
  switchMap(() => netconf.close()),
  catchError(error => {
    console.error('Edit failed', error);
    return of(void 0);
  }),
).subscribe();
```

### Custom RPC

This example shows how to use a custom RPC, in this case to get YANG schema for the first registered model.

Using promises:
```typescript
// Get YANG schema for the first registered model:
const netconf = new Netconf({
  host: 'localhost',
  port: 2022,
  user: 'admin',
  pass: 'admin',
  // Provide the namespace of the netconf-monitoring module for the get-schema RPC
  namespace: 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring',
  // Strip namespaces from the result to only have the schema text
  ignoreAttrs: true,
});
try {
  const data = await firstValueFrom(netconf.getData('/netconf-state/schemas/schema[1]'));
  const identifier = (data.result as any)['netconf-state'].schemas.schema.identifier;
  const schema = await firstValueFrom(netconf.rpc('/get-schema', { identifier }));
  await firstValueFrom(netconf.close());
  console.log(schema.result?.data);
} catch (error) {
  console.error('RPC error:', error);
}
```

Using RxJS:
```typescript
const netconf = new Netconf({
  host: 'localhost',
  port: 2022,
  user: 'admin',
  pass: 'admin',
  // Provide the namespace of the netconf-monitoring module for the get-schema RPC
  namespace: 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring',
  // Strip namespaces from the result to only have the schema text
  ignoreAttrs: true,
});
netconf.getData('/netconf-state/schemas/schema[1]').pipe(
  map(data => (data.result as any)['netconf-state'].schemas.schema.identifier),
  switchMap(identifier => netconf.rpc('/get-schema', { identifier })),
  map(data => data.result?.data),
  tap(data => console.log(data)),
  switchMap(() => netconf.close()),
).subscribe();
```

### Concurrency

Example of concurrent operations using RxJS.

```typescript
combineLatest([
  netconf.getData('/confd-state/version'),
  netconf.getData('//aaa//user[name="admin"]'),
  netconf.getData('//sessions//username'),
]).pipe(
  tap(([version, user, username]) => {
    console.log(version);
    console.log(user);
    console.log(username);
  }),
  switchMap(() => netconf.close()),
).subscribe();
```

### Subscribe to events

Example of event subscription using RxJS.

```typescript
// A subject that, when emitted, will stop the subscription
const stop$ = new Subject<void>();

// Subscribe to notifications
netconf.subscription({xpath: '/'}, stop$).pipe(
  switchMap(notification => {
    if(notification?.result?.hasOwnProperty('ok')) {
      // This is a RPC Reply from ConfD with OK
      console.log('Subscription started');
      // Return NEVER, to continue the subscription and wait for notifications
      return NEVER;
    } else if (notification !== undefined) {
      // This is a notification from ConfD
      console.log('Notification:', notification);
      // Return NEVER, to continue the subscription and wait for more notifications
      return NEVER;
    } else { // notification === undefined
      // When undefined is received, the subscription is stopped
      console.log('Subscription stopped');
      // Return of(void 0), to continue down the pipe and close the connection
      return of(void 0);
    }
  }),
  catchError(_error => of(void 0)),
  switchMap(() => {
    console.log('Closing connection');
    return netconf.close();
  }),
).subscribe({
  next: () => {},
  error: (err: Error) => console.error('Subscription failed:', err.message),
});

// Stop the subscription after 10 seconds
timer(10000).pipe(
  tap(() => {
    stop$.next();
    stop$.complete();
  }),
  // Wait for the subscription to stop and connection to close
  switchMap(() => timer(1000)),
  map(() => void 0),
).subscribe();
```

See the Library and CLI tool source code for more advanced usage examples.

## API

- `Netconf(params: NetconfParams)`

    Initializes a new Netconf instance. The `params` object specifies connection parameters (host, port, username,
    password) and an optional namespace that is added to the request.

    Instead of `pass`, the client can authenticate with a public key or with an ssh agent. Provide the *content*
    of the key file in `privateKey` (with `passphrase` if the key is encrypted), or the path to the agent socket
    in `agent`:
    ```typescript
    const netconf = new Netconf({
      host: 'localhost',
      port: 2022,
      user: 'admin',
      privateKey: await readFile('/home/user/.ssh/id_ed25519'),
      // passphrase: 'secret',
      // agent: process.env.SSH_AUTH_SOCK,
    });
    ```
    At least one of `pass`, `privateKey` or `agent` is required.

    Note that the connection to the server is lazy-loaded and won't be established until you invoke a method
    on the instance.

- `.close(): Observable<void>`

    Close the connection.

- `.hello(): Observable<HelloResult>`

    Returns the server's hello message.

- `.getData(xpath: string, configFilter?: ConfigFilterType): Observable<GetDataResult>`

    Send a get-data request to the server. The request uses the `xpath` expression provided.

    The `configFilter` specifies whether to request _configuration_ or _state_ data or both.

- `.editConfigMerge(xpath: string, values: object): Observable<EditConfigResult>`

    Send an edit-config (merge operation) request to the server. The `values` argument is an object containing
    the key-value pairs to be merged into the configuration.

    These two operations are equivalent and will produce identical request to the server:
    ```typescript
    netconf.editConfigMerge('//list[key="keyName"]', {param: 'newValue'});
    netconf.editConfigMerge('//list', {key: 'keyName', param: 'newValue'});
    ```

    The `values` object may have multiple levels of nesting.

- `.editConfigCreate(xpath: string, values: object, beforeKey?: string): Observable<EditConfigResult>`

    Send an edit-config (create operation) request to the server. The `values` argument is an object containing
    the key-value pairs to be created in the configuration.

    The `beforeKey` specifies where to insert the new container in the configuration (for ordered lists). Example:
    ```typescript
    netconf.editConfigCreate('//list', {name: 'newEntry'}, '[name="existingEntry"]');
    ```

- `.editConfigDelete(xpath: string, values: object): Observable<EditConfigResult>`

    Send an edit-config (delete operation) request to the server. The `xpath` argument is the XPath expression
    of the container to be deleted. The `values` argument should provide the key of the container to be deleted.
    Example:

    ```typescript
    const netconf = new Netconf({
      host: 'localhost',
      port: 2022,
      user: 'admin',
      pass: 'admin',
      namespace: 'http://tail-f.com/ns/aaa/1.1',
    });
    netconf.editConfigDelete('//aaa//user', {name: 'public'}); 
    ```
- `.editConfigReplace(xpath: string, values: object): Observable<EditConfigResult>`

    Send an edit-config (replace operation) request to the server.

- `.editConfigCreateListItems(xpath: string, listItems: string[]): Observable<EditConfigResult>`

    Creates a list item in the configuration.

- `.editConfigDeleteListItems(xpath: string, listItems: string[]): Observable<EditConfigResult>`

    Deletes a list item in the configuration.

- `.subscription(xpathOrStream: SubscriptionOption, stop$?: Subject<void>):
   Observable<NotificationResult | RpcResult | undefined>`

    Send a subscription request to the server and return an observable that emits notifications as they are received.
    The `xpathOrStream` can be an object containing the property `xpath` with the XPath expression to subscribe
    to, or an object containing the property `stream` with the stream name to subscribe to.

    The `stop$` observable is an optional subject that, when emitted, will stop the subscription.

    The return value is an observable that emits in order:
    - Result of the RPC subscription request;
    - Notifications as they are received;
    - `undefined` when the subscription is stopped.

- `.rpc(cmd: string, values: object): Observable<RpcResult>`

    Send a custom RPC request to the server and return the result. The `cmd` parameter is the name of the RPC or action
    provided as an XPath expression (see example).

    The `values` object is an optional argument that contains the parameters for the RPC or action. This object
    can have multiple levels of nesting. The special key `$` is used to specify attributes of the element
    (for example, a namespace).

    Example for RPC command `get` with an XPath filter. This results in a similar request
    as `netconf.getData('/confd-state/version')`:
    ```typescript
    netconf.rpc('/get', {
      filter: {
        $: {
          type: 'xpath',
          select: '/confd-state/version',
        }
      }
    });
    ```

## Troubleshooting

### Getting "RPC Error: Unknown element" when executing one of _editConfig_ methods

This error occurs when the server cannot find one of the parts of the XPath expression. Most likely reason is
that the request misses a namespace. Provide the namespace using the `namespace` parameter in the constructor.

### Result of getData() is empty string

The requested container was not found in the configuration or state data on the server. Likely cause: the XPath
expression is incorrect.

### Debugging

To debug the library, set the `debug` callback in the constructor options:

```typescript
const netconf = new Netconf({
  ...
  debug: (message: string, level: number) => {
    console.log(`DEBUG[${level}]: ${message}`);
  },
});
```


## License

This project is licensed under the [MIT License](https://github.com/kolotsey/netconf-client/blob/main/LICENSE).
