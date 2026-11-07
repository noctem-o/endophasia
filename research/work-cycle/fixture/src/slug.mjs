// WORK-CYCLE-001A fixture. `slugify` turns a title into a URL slug. It is deliberately incomplete: runs of spaces and
// punctuation are not collapsed and the ends are not trimmed, so the second test fails at the fixture's first commit.
export function slugify(title) {
	return title.toLowerCase().replace(/ /g, "-");
}
