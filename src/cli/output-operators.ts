import { MonoTypeOperatorFunction, tap } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { stringify as yamlStringify } from 'yaml';
import { EditConfigResult, MultipleEditError, Result, RpcResult, SafeAny } from '../lib/index.ts';
import { yellow } from './output-colors.ts';
import { Output } from './output.ts';
import { ResultFormat } from './parse-args.ts';
import { asTree } from 'object-as-tree';
import * as xml2js from 'xml2js';

/**
 * A helper class to manage EPIPE when writing to stdout
 */
class Writer{
  public static write(data: string): void {
    const writer = Writer.getInstance();

    if(writer.error){
      if(writer.error.hasOwnProperty('code') && (writer.error as SafeAny).code === 'EPIPE'){
        // Ignore EPIPE errors
      }else{
        throw new Error(`Error writing to stdout: ${writer.error.message}`);
      }
    }else{
      writer.writeStdout(data);
    }
  }

  private static instance?: Writer;

  private static getInstance(): Writer {
    if (!Writer.instance) {
      Writer.instance = new Writer();
    }
    return Writer.instance;
  }

  private error?: Error;

  private constructor() {
    process.stdout.on('error', (e: Error): void => {
      const writer = Writer.getInstance();
      writer.error = e;
      if(e.hasOwnProperty('code') && (e as SafeAny).code === 'EPIPE'){
        // Ignore EPIPE errors
      }else{
        // This error will not be caught by RxJS
        throw new Error(`Error writing to stdout: ${e.message}`);
      }
    });
  }

  private writeStdout(data: string): void {
    process.stdout.write(data);
  }
}

/**
 * Builder for the XML output format. Headless: a result stream (e.g. the notifications of a
 * subscription) is written as a sequence of documents, and an XML header in front of every
 * one of them would leave the stream unparseable
 */
const xmlBuilder = new xml2js.Builder({ headless: true });

/**
 * Pretty-print an XML document received from the server. The original XML is returned as is
 * if it cannot be parsed or carries no document, so that the payload is never replaced by an
 * error message on stdout. A parsing failure is reported on stderr.
 *
 * @param xml - The XML document received from the server
 * @returns The pretty-printed document, or the original XML if it cannot be parsed
 */
function prettyXml(xml: string): string {
  let pretty: string | undefined;
  // parseString calls back synchronously for a string input
  xml2js.parseString(xml, (err, result) => {
    if(err){
      Output.error(`Failed to parse the XML received from the server: ${err.message}`);
    }else if(result){
      pretty = xmlBuilder.buildObject(result);
    }
  });
  return pretty ?? xml;
}

function formatPrimitive(val: SafeAny): string {
  if (typeof val === 'string') {
    if (val.includes('\n')) {
      return `'${val.replace(/'/g, '\\\'')}'`;
    }
    return val;
  }
  return String(val);
}

function printKeyValue(prefix: string, obj: SafeAny): void {
  if(Array.isArray(obj)){
    // Array of objects: recurse into each item
    obj.forEach((item, index) => {
      // In XPath index starts at 1
      const indexedPrefix = `${prefix}[${index+1}]`;
      printKeyValue(indexedPrefix, item);
    });
  }else if(obj && typeof obj === 'object'){
    for(const key of Object.keys(obj)){
      const keyPrefix = prefix === '/' ? `/${key}` : prefix.length > 0 ? `${prefix}/${key}` : key;
      printKeyValue(keyPrefix, obj[key]);
    }
  }else if(prefix.length > 0 && prefix !== '/'){
    // Primitive: print the value
    Writer.write(`${prefix}=${formatPrimitive(obj)}\n`);
  }
}

/**
 * RxJs operator - write the result to the console in the specified format
 *
 * @param data - The result to write
 * @param format - The format to write the result in
 */
export function writeData(format: ResultFormat): MonoTypeOperatorFunction<Result | [Result, boolean]> {
  return tap(input => {
    // If the input is an array, the first element is the result and the second is a boolean
    // indicating if the result is the root result
    const [data, isRootResult] = Array.isArray(input) && input.length === 2 && typeof input[1] === 'boolean'
      ? input
      : [input as Result, false];
    switch (format) {
    case ResultFormat.XML:
      Writer.write(prettyXml(data.xml));
      Writer.write('\n');
      break;

    case ResultFormat.JSON:
      if(data.result === undefined){
        Writer.write(JSON.stringify(null));
      }else{
        Writer.write(JSON.stringify(data.result, null, 2));
      }
      Writer.write('\n');
      break;

    case ResultFormat.YAML:
      if(data.result === undefined){
        Writer.write(yamlStringify(null));
      }else{
        Writer.write(yamlStringify(data.result));
      }
      break;

    case ResultFormat.KEYVALUE:
      printKeyValue(isRootResult ? '/' : '', data.result);
      break;

    case ResultFormat.TREE:
    default:
      Writer.write(data.result as SafeAny === '' ? yellow('no result') : asTree(data.result));
      Writer.write('\n');
      break;
    }
  });
}

/**
 * RxJs operator - throw an error if the operation is not allowed to edit multiple schema branches
 */
export function catchMultipleEditError(): MonoTypeOperatorFunction<EditConfigResult> {
  return catchError(error => {
    if(error instanceof MultipleEditError){
      Output.error('Editing multiple schema branches not allowed. Use --allow-multiple to override.');
      throw new Error('Operation not performed');
    }
    throw error;
  });
}

/**
 * RxJs operator - set the resulting status of the edit-config
 */
export function setEditConfigStatus(): MonoTypeOperatorFunction<EditConfigResult> {
  return setStatus();
}

/**
 * RxJs operator - set the resulting status of the RPC
 */
export function setRpcConfigStatus(): MonoTypeOperatorFunction<RpcResult> {
  return setStatus();
}

function setStatus(): MonoTypeOperatorFunction<Result> {
  return map((data: Result) => {
    if(data.result?.ok !== undefined){
      data.result.ok = 'operation successful';
    }
    return data;
  });
}
