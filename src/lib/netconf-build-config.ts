import { map, Observable, of, switchMap, tap } from 'rxjs';
import { NamespaceType, NetconfType, SafeAny } from './netconf-types.ts';
import { Output } from '../cli/output.ts';

/**
 * Build a configuration object for Netconf edit-config RPC based on the XPath filter.
 * The class takes the XPath filter and the schema observable and builds the configuration object
 * that can be used in edit-config RPC.
 */
export class NetconfBuildConfig {
  private xpath: string;

  private schema?: Observable<NetconfType>;

  private namespace?: string | (string | NamespaceType)[];

  private guessNamespace?: Observable<string | undefined>;

  private get hasNamespace(): boolean {
    return this.namespace !== undefined && (
      typeof this.namespace === 'string' || (Array.isArray(this.namespace) && this.namespace.length > 0)
    );
  }

  /**
   * Create a new BuildEditConfig object.
   *
   * @param {string} xpath - XPath filter of the configuration object,
   *   for example, //interfaces/interface[name="eth1"]
   * @param {Observable<NetconfType>} schema - Observable that emits the schema of the device.
   *   The class may use it if the XPath filter is not straightforward.
   * @param {string | (string | NamespaceType)[]} namespace - Optional target namespace for the configuration object.
   *   it can also be an array of namespaces with their aliases, see {@link NamespaceType}.
   */
  public constructor(
    xpath: string,
    schema?: Observable<NetconfType>,
    namespace?: string | (string | NamespaceType)[],
    guessNamespace?: Observable<string | undefined>
  ) {
    xpath = xpath.trim();
    if(!xpath || xpath === '/' || xpath === '//'){
      throw new Error('XPath for edit-config must contain at least one element');
    }
    if(xpath.includes('|')){
      throw new Error('XPath for edit-config must not contain |');
    }
    this.xpath = xpath;
    this.schema = schema;
    this.namespace = namespace;
    this.guessNamespace = guessNamespace;
  }


  /**
   * Build a configuration object for Netconf edit-config RPC. The function will return an array of configuration
   * objects, that is, the object where configuration must be updated according to the xpath filter.
   * For example, if Xpath filter is //interfaces/interface[name="eth1"], the function will return an array of
   * objects, containing the interface with name eth1 (array of one object).
   *
   * @param {NetconfType} targetObj - The root configuration object from which to build the configuration based
   *   on the XPath filter.
   *
   * @returns {NetconfType[]} Array of objects where configuration must be updated, for example,
   *   for the XPath //interfaces/interface[name="eth1"], the function will return an array of one object
   *   containing the interface with name eth1. The returned objects are nested in the targetObj.
   *   The function returns an empty array if:
   *   - the schema is not provided.
   *   - the XPath filter cannot be matched with schema of XPath
   */
  public build(targetObj: NetconfType): Observable<NetconfType[]> {
    if(!(this.xpath.includes('//') || this.xpath.includes('*'))){
      // Try to build based on XPath first
      return this.buildFromXPath(targetObj).pipe(
        switchMap(result => {
          if(result !== undefined){
            return of(result);
          }
          if(this.schema === undefined){
            return of([]);
          }
          return this.buildFromSchema(this.schema, targetObj);
        }),
      );
    }
    if(this.schema){
      return this.buildFromSchema(this.schema, targetObj);
    }
    return of([]);
  }

  /**
   * Build a configuration object for Netconf edit-config RPC based on the XPath filter. The function will
   * attempt to build the configuration object from the XPath provided. If the XPath has features not supported
   * by the function, the function will return undefined. The function only supports full XPath with
   * predicates for matching nodes.
   *
   * @param {NetconfType} targetObj - The root configuration object from which to build the configuration based
   *   on the XPath filter.
   *
   * @returns {NetconfType[] | undefined} Array including the configuration object that needs to be updated.
   */
  private buildFromXPath(targetObj: NetconfType): Observable<NetconfType[] | undefined> {
    const VALID_SEGMENT = /^([\w.:\-]+)(?:\[([^=@]+)=(["'])([^"'\]]+)\3])?$/;
    // Split the XPath filter into tokens
    const xpathSegments = this.xpath.split('/').filter(x => x !== '');
    // Check each segment is valid
    for (const segment of xpathSegments) {
      if (!VALID_SEGMENT.test(segment)) {
        return of(undefined);
      }
    }

    // Observable for namespace, requesting server if needed
    const namespace: Observable<Record<string, string> | undefined> = this.hasNamespace
      ? of(this.getNamespaces())
      : this.guessNamespace
        ? of(null).pipe(
          tap(() => Output.debug('Sending request to the server to guess the namespace')),
          switchMap(() => this.guessNamespace ? this.guessNamespace : of(undefined)),
          map(ns => ns ? { xmlns: ns } : undefined),
        )
        : of(undefined);

    return namespace.pipe(
      map(ns => {
        let current = targetObj;

        for (let i = 0; i < xpathSegments.length; i++) {
          const segment = xpathSegments[i];
          const match = segment.match(VALID_SEGMENT);

          if (!match) return undefined;

          const [, tag, predKey, , predVal] = match;
          current[tag] = i === 0 && ns
            ? { $: ns }
            : {};

          if (predKey && predVal) {
            current[tag][predKey] = predVal;
          }

          current = current[tag];
        }

        return [current];
      }),
    );
  }

  /**
   * Build a configuration object for Netconf edit-config RPC based on the schema. The function will
   * request the schema from the server using the xpath filter and build the configuration object based on the schema.
   *
   * @param {NetconfType} targetObj - The root configuration object from which to build the configuration based
   *   on the XPath filter.
   *
   * @returns {NetconfType[]} Array of objects where configuration must be updated.
   */
  private buildFromSchema(schema: Observable<NetconfType>, targetObj: NetconfType): Observable<NetconfType[]> {
    // remove leading / or //
    let xpath = this.xpath.replace(/^\/+/, '');
    // convert wildcard to *
    xpath = xpath.replace(/\/\//g, '/*/');
    // merge */* into *
    xpath = xpath.replace(/\*\/\*/g, '*');

    // remove any predicates/matching square brackets from the xpath
    const regExp = /\[[^[\]]*]/;
    while(regExp.test(xpath)){
      xpath = xpath.replace(regExp, '');
    }
    const xpathSegments = xpath.split('/');

    Output.debug('Build configuration object based on leaf schema');
    Output.debug('Sending request to the server to get the leaf schema');
    return schema.pipe(
      map((schemaObj: NetconfType) => {
        // Deep copy schema into targetObj
        Object.assign(targetObj, structuredClone(schemaObj));
        // match the schema with the xpath and return the config parts

        if((targetObj.$ as NetconfType)?.xmlns) delete (targetObj.$ as NetconfType).xmlns;
        return this.findConfigPartsInSchema(targetObj, xpathSegments);
      }),
    );
  }

  private findConfigPartsInSchema(schema: NetconfType, xpathSteps: string[]): NetconfType[] {
    const configParts: NetconfType[] = [];

    // Helper function to recursively search the schema
    // eslint-disable-next-line sonarjs/cognitive-complexity
    const searchSchema = (currentObj: NetconfType, steps: string[], step: number): boolean => {
      if(steps.length === 0){
        this.stripNestedObjects(currentObj);
        configParts.push(currentObj);
        return true;
      }

      if(steps.length === 1 && steps[0] === '*' && !Array.isArray(currentObj)){
        this.stripNestedObjects(currentObj);
        configParts.push(currentObj);
        return true;
      }

      if(typeof currentObj !== 'object' || currentObj === null) {
        return false;
      }

      // Iterate through the properties of currentObj
      let branchPassed = false;
      for(const key of Object.keys(currentObj)){
        const isWildcardMatch = steps[0] === '*' && steps.length > 1 && key === steps[1];

        let twigPassed: boolean;
        if(key === steps[0] || isWildcardMatch){
          const newSteps = isWildcardMatch ? steps.slice(1) : steps;
          // If this is our object, but it is an array, convert it to an object
          if(newSteps.length === 1 && Array.isArray(currentObj[key])){
            currentObj[key] = {};
          // eslint-disable-next-line sonarjs/no-duplicated-branches
          } else if (newSteps.length === 1 && typeof currentObj[key] === 'string' && currentObj[key] === '') {
            currentObj[key] = {};
          }
          twigPassed = searchSchema(currentObj[key] as NetconfType, newSteps.slice(1), step + 1);
        }else if(steps[0] === '*' && steps.length === 1){
          twigPassed = searchSchema(currentObj[key] as NetconfType, [], step + 1);
        }else{
          twigPassed = searchSchema(currentObj[key] as NetconfType, steps, step + 1);
        }
        branchPassed = twigPassed || branchPassed;

        // Prune this key if nothing below it matched the xpath. The check is per key: a sibling
        // that matched must not keep the other, non-matching siblings in the configuration
        if (!twigPassed && (Array.isArray(currentObj[key]) || typeof currentObj[key] === 'object') && key !== '$') {
          delete currentObj[key];
        }
      }
      if(step === 1 && this.hasNamespace){
        currentObj.$ = {
          ...currentObj.$ ?? {} as SafeAny,
          ...this.getNamespaces(),
        };
      }
      return branchPassed;
    };

    // Start the recursive search
    searchSchema(schema, xpathSteps, 0);
    return configParts;
  }

  private stripNestedObjects = (obj: NetconfType): void => {
    if (typeof obj === 'object' && obj !== null) {
      Object.keys(obj).forEach(key => {
        if (obj[key] && typeof obj[key] === 'object' && key !== '$') {
          delete obj[key];
        }
      });
    }
  };

  private getNamespaces(): Record<string, string> | undefined {
    if(typeof this.namespace === 'string'){
      return { xmlns: this.namespace };
    }
    return this.namespace?.reduce((acc, curr) => {
      if(typeof curr === 'string'){
        acc.xmlns = curr;
      }else{
        acc[`xmlns:${curr.alias}`] = curr.uri;
      }
      return acc;
    }, {} as Record<string, string>);
  }
}
