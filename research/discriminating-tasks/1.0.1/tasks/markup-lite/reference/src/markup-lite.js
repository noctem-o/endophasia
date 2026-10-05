const SPECIAL = "*_`\\";
const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const isSpace = (ch) => /\s/.test(ch);
const isAlnum = (ch) => ch !== undefined && /[A-Za-z0-9]/.test(ch);

export function render(text) {
	if (typeof text !== "string") throw new TypeError("text must be a string");
	return parse(text, 0, text.length);
}

function codeEnd(s, i, hi) {
	const j = s.indexOf("`", i + 1);
	return j !== -1 && j < hi ? j : -1;
}

function findCloser(s, i, hi) {
	const c = s[i];
	for (let k = i + 1; k < hi; k++) {
		const ch = s[k];
		if (ch === "\\" && k + 1 < hi && SPECIAL.includes(s[k + 1])) {
			k++;
			continue;
		}
		if (ch === "`") {
			const j = codeEnd(s, k, hi);
			if (j > k + 1) k = j;
			else if (j === k + 1) k = j;
			continue;
		}
		if (ch !== c || k === i + 1 || isSpace(s[k - 1])) continue;
		if (c === "_" && isAlnum(s[k + 1])) continue;
		return k;
	}
	return -1;
}

function parse(s, lo, hi) {
	let out = "";
	let i = lo;
	while (i < hi) {
		const c = s[i];
		if (c === "\\" && i + 1 < hi && SPECIAL.includes(s[i + 1])) {
			out += esc(s[i + 1]);
			i += 2;
		} else if (c === "`") {
			const j = codeEnd(s, i, hi);
			if (j === i + 1) {
				out += "``";
				i += 2;
			} else if (j > i + 1) {
				out += `<code>${esc(s.slice(i + 1, j))}</code>`;
				i = j + 1;
			} else {
				out += "`";
				i++;
			}
		} else if (c === "*" || c === "_") {
			const opens = i + 1 < hi && !isSpace(s[i + 1]) && (c === "*" || !isAlnum(s[i - 1]));
			const k = opens ? findCloser(s, i, hi) : -1;
			if (k === -1) {
				out += c;
				i++;
			} else {
				const tag = c === "*" ? "b" : "i";
				out += `<${tag}>${parse(s, i + 1, k)}</${tag}>`;
				i = k + 1;
			}
		} else {
			out += esc(c);
			i++;
		}
	}
	return out;
}
