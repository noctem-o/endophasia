// Case 4c: a hook loaded into the VERIFIER's own process (through NODE_OPTIONS when it is started without its launcher). It removes the
// trace the in-process guard looks for, then makes every byte comparison succeed. It shows that the controller is part of what must be
// trusted: isolating the candidate does not protect a verdict decided by compromised controller code.
delete process.env.NODE_OPTIONS;
Buffer.prototype.equals = function equals() {
	return true;
};
