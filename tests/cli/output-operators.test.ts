import { firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, MockInstance, test, vi } from 'vitest';
import { stringify as yamlStringify } from 'yaml';
import { catchMultipleEditError, setEditConfigStatus, writeData } from '../../src/cli/output-operators';
import { ResultFormat } from '../../src/cli/parse-args';
import { EditConfigResult, MultipleEditError, Result, SafeAny } from '../../src/lib';

describe('writeData', () => {
  let stdoutWrite: MockInstance;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
  });

  test('writes XML', async () => {
    const data = { xml: '<foo/>', result: { foo: 1 } };
    await firstValueFrom(of(data).pipe(writeData(ResultFormat.XML)));
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('<foo/>'));
  });

  test('writes JSON', async () => {
    const data = { xml: '', result: { foo: 1 } };
    await firstValueFrom(of(data).pipe(writeData(ResultFormat.JSON)));
    expect(stdoutWrite).toHaveBeenCalledWith(JSON.stringify({ foo: 1 }, null, 2));
  });

  test('writes empty string for JSON', async () => {
    const data = { xml: '', result: '' as SafeAny };
    await firstValueFrom(of(data).pipe(writeData(ResultFormat.JSON)));
    expect(stdoutWrite).toHaveBeenCalledWith(JSON.stringify(''));
  });

  test('writes YAML', async () => {
    const data = { xml: '', result: { foo: 1 } };
    await firstValueFrom(of(data).pipe(writeData(ResultFormat.YAML)));
    expect(stdoutWrite).toHaveBeenCalledWith(yamlStringify({ foo: 1 }));
  });

  test('writes KEYVALUE', async () => {
    const data = { xml: '', result: { foo: 1 } };
    await firstValueFrom(of(data).pipe(writeData(ResultFormat.KEYVALUE)));
    expect(stdoutWrite).toHaveBeenCalledWith('foo=1\n');
  });

  test('writes nothing if empty string for KEYVALUE', async () => {
    const data = { xml: '', result: '' as SafeAny };
    await firstValueFrom(of(data).pipe(writeData(ResultFormat.KEYVALUE)));
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  test('writes nothing if empty string for KEYVALUE with root prefix', async () => {
    const data = { xml: '', result: '' as SafeAny };
    await firstValueFrom(of([data, true] as [Result, boolean]).pipe(writeData(ResultFormat.KEYVALUE)));
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  test('writes empty string for YAML', async () => {
    const data = { xml: '', result: '' as SafeAny };
    await firstValueFrom(of(data).pipe(writeData(ResultFormat.YAML)));
    expect(stdoutWrite).toHaveBeenCalledWith(yamlStringify(''));
  });

  test('writes TREE', async () => {
    const data: Result = { xml: '', result: 'test' as SafeAny };
    await firstValueFrom(of(data).pipe(writeData(ResultFormat.TREE)));
    expect(stdoutWrite).toHaveBeenCalledWith('\'test\'');
  });

  test('writes "no result" for TREE', async () => {
    const data: Result = { xml: '', result: '' as SafeAny };
    await firstValueFrom(of(data).pipe(writeData(ResultFormat.TREE)));
    expect(stdoutWrite).toHaveBeenCalledWith('no result');
  });
});

describe('catchMultipleEditError', () => {
  let stderrWrite: MockInstance;
  beforeEach(() => {
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrWrite.mockRestore();
  });

  test('throws error with message for MultipleEditError', async () => {
    const error = new MultipleEditError();
    await expect(() =>
      firstValueFrom(throwError(() => error).pipe(catchMultipleEditError()))
    ).rejects.toThrow('Operation not performed');
  });

  test('rethrows other errors', async () => {
    const error = new Error('other');
    await expect(() =>
      firstValueFrom(throwError(() => error).pipe(catchMultipleEditError()))
    ).rejects.toThrow('other');
  });
});

describe('setEditConfigStatus', () => {
  let stderrWrite: MockInstance;
  beforeEach(() => {
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrWrite.mockRestore();
  });

  test('sets ok to "operation successful" if no errors', async () => {
    const data: EditConfigResult = { result: { ok: '' }, xml: '' };
    const result: EditConfigResult = await firstValueFrom(of(data).pipe(setEditConfigStatus()));
    expect(result.result).toEqual(expect.objectContaining({ ok: 'operation successful' }));
  });

  test('passes error through', async () => {
    const error = new Error('test');
    await expect(() =>
      firstValueFrom(throwError(() => error).pipe(setEditConfigStatus()))
    ).rejects.toThrow('test');
  });
});
