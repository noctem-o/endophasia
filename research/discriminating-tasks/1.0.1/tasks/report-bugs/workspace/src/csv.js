const isBlank = (ch) => ch === " " || ch === "\t";

export function parseCsvLine(line) {
	const fields = [];
	const n = line.length;
	let i = 0;
	for (;;) {
		while (i < n && isBlank(line[i])) i++;
		if (line[i] === '"') {
			i++;
			let value = "";
			for (;;) {
				if (i >= n) throw new SyntaxError("unterminated quote");
				if (line[i] === '"') {
					i++;
					break;
				}
				value += line[i++];
			}
			while (i < n && isBlank(line[i])) i++;
			if (i < n && line[i] !== ",") throw new SyntaxError("text after closing quote");
			fields.push(value);
		} else {
			let j = line.indexOf(",", i);
			if (j === -1) j = n;
			fields.push(line.slice(i, j).replace(/[ \t]+$/, ""));
			i = j;
		}
		if (i >= n) break;
		i++;
	}
	return fields;
}

export function parseCsv(text) {
	if (typeof text !== "string") throw new TypeError("text must be a string");
	const lines = text.split(/\r?\n/);
	let header;
	const rows = [];
	lines.forEach((line, index) => {
		if (line === "") return;
		const fields = parseCsvLine(line);
		if (header === undefined) {
			header = fields;
			return;
		}
		if (fields.length !== header.length) {
			throw new RangeError(`line ${index + 1}: expected ${header.length} fields, got ${fields.length}`);
		}
		rows.push(Object.fromEntries(header.map((name, k) => [name, fields[k]])));
	});
	return rows;
}
