declare module "promise.try" {
	interface PromiseTry {
		<T>(callback: () => T | PromiseLike<T>): Promise<T>;
		shim(): void;
	}
	const promiseTry: PromiseTry;
	export default promiseTry;
}
