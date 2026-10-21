/**
 * Loads a real package the way ts2emdash.mts does, but throws so callers and tests can catch it.
 * CommonJS packages come back as { default: module }, so callers read `.default` when they need it.
 */
export async function load<T>(spec: string, name: string = spec): Promise<T> {
	try {
		return await import(spec);
	} catch {
		throw new Error(`Could not load ${spec}. Run this from the folder that holds package.json and install it: npm i -D ${name}`);
	}
}
