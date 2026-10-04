const ALPHABET = "ACDEFGHJKLMNPQRSTUVWXYZ";

function rowLabel(row) {
	let n = row;
	let label = "";
	while (n > 0) {
		n -= 1;
		label = String.fromCharCode(65 + (n % 26)) + label;
		n = Math.floor(n / 26);
	}
	return label;
}

function rowNumber(label) {
	let n = 0;
	for (const letter of label) n = n * 26 + (letter.charCodeAt(0) - 64);
	return n;
}

function checkLetter(text) {
	let sum = 0;
	for (let index = 0; index < text.length; index += 1) sum += text.charCodeAt(index);
	return ALPHABET[sum % 23];
}

const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

export function encodeTicket({ venue, row, seat }) {
	if (!integer(venue, 1, 99)) throw new RangeError("venue must be an integer from 1 to 99");
	if (!integer(row, 1, Number.MAX_SAFE_INTEGER)) throw new RangeError("row must be an integer of 1 or more");
	if (!integer(seat, 1, 999)) throw new RangeError("seat must be an integer from 1 to 999");
	const body = `V${String(venue).padStart(2, "0")}-${rowLabel(row)}-${String(seat).padStart(3, "0")}`;
	return `${body}-${checkLetter(body)}`;
}

export function decodeTicket(code) {
	const match = typeof code === "string" ? /^V(\d{2})-([A-Z]+)-(\d{3})-([A-Z])$/.exec(code) : null;
	if (match === null) throw new SyntaxError("not a ticket code");
	const venue = Number(match[1]);
	const seat = Number(match[3]);
	if (venue === 0 || seat === 0) throw new RangeError("venue and seat start at 1");
	const body = code.slice(0, code.lastIndexOf("-"));
	if (checkLetter(body) !== match[4]) throw new RangeError("wrong check letter");
	return { venue, row: rowNumber(match[2]), seat };
}
