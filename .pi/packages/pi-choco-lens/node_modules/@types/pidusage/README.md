# Installation
> `npm install --save @types/pidusage`

# Summary
This package contains type definitions for pidusage (https://github.com/soyuka/pidusage).

# Details
Files were exported from https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/pidusage.
## [index.d.ts](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/pidusage/index.d.ts)
````ts
interface Stat {
    /**
     * percentage (from 0 to 100*vcore)
     */
    cpu: number;

    /**
     * bytes
     */
    memory: number;

    /**
     * PPID
     */
    ppid: number;

    /**
     * PID
     */
    pid: number;

    /**
     * ms user + system time
     */
    ctime: number;

    /**
     * ms since the start of the process
     */
    elapsed: number;

    /**
     * ms since epoch
     */
    timestamp: number;
}

declare function pidusage(pid: number | string, callback: (err: Error | null, stats: Stat) => void): void;
declare function pidusage(
    pid: number | string,
    options: { [key: string]: any },
    callback: (err: Error | null, stats: Stat) => void,
): void;
declare function pidusage(
    pids: Array<number | string>,
    callback: (err: Error | null, stats: { [key: string]: Stat }) => void,
): void;
declare function pidusage(
    pids: Array<number | string>,
    options: { [key: string]: any },
    callback: (err: Error | null, stats: { [key: string]: Stat }) => void,
): void;
declare function pidusage(pid: number | string, options?: { [key: string]: any }): Promise<Stat>;
declare function pidusage(
    pids: Array<number | string>,
    options?: { [key: string]: any },
): Promise<{ [key: string]: Stat }>;

declare namespace pidusage {
    type Status = Stat;

    /**
     * If needed this function can be used to clear the event loop.
     * Indeed, we're registering an interval to free up the in-memory metrics.
     * By calling this, it will clear this interval and all delete all in-memory data
     */
    function clear(): void;
}

export = pidusage;

````

### Additional Details
 * Last updated: Tue, 07 Nov 2023 09:09:39 GMT
 * Dependencies: none

# Credits
These definitions were written by [Cyril Schumacher](https://github.com/cyrilschumacher).
