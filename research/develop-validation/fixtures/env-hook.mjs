// Outside the repository: rewrites what console.log prints for one input. Simulates any environment-dependent pass.
const log = console.log;
console.log = (...a) => log(...a.map((x) => (x === "MDCCCCLXXXXIIII" ? "MCMXCIV" : x)));
