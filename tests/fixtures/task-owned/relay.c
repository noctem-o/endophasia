/* Test double for a llama.cpp server: maps the model, listens on 127.0.0.1:--port and relays bytes to the in-process
   fake endpoint at BACKEND_PORT. One process, no fork: a forked child would inherit the listener. */
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#ifndef BACKEND_PORT
#error BACKEND_PORT
#endif
#define MAXC 32
static void relay(int from, int to, int *ok) {
	char buf[65536];
	ssize_t r = read(from, buf, sizeof buf);
	if (r <= 0) { *ok = 0; return; }
	for (ssize_t off = 0; off < r;) {
		ssize_t w = write(to, buf + off, r - off);
		if (w <= 0) { *ok = 0; return; }
		off += w;
	}
}
int main(int n, char **v) {
	char *model = 0; int port = 0;
	for (int i = 1; i + 1 < n; i++) {
		if (!strcmp(v[i], "--model")) model = v[i + 1];
		if (!strcmp(v[i], "--port")) port = atoi(v[i + 1]);
	}
	if (!model || !port) return 2;
	int f = open(model, O_RDONLY);
	if (f < 0 || mmap(0, 4096, PROT_READ, MAP_PRIVATE, f, 0) == MAP_FAILED) return 3;
	signal(SIGPIPE, SIG_IGN);
	int s = socket(AF_INET, SOCK_STREAM, 0), one = 1;
	setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
	struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK), .sin_port = htons(port) };
	if (bind(s, (void *)&a, sizeof a) || listen(s, 16)) return 4;
	int cf[MAXC], bf[MAXC], count = 0;
	for (;;) {
		struct pollfd p[1 + 2 * MAXC];
		p[0].fd = s; p[0].events = POLLIN;
		for (int i = 0; i < count; i++) {
			p[1 + 2 * i].fd = cf[i]; p[1 + 2 * i].events = POLLIN;
			p[2 + 2 * i].fd = bf[i]; p[2 + 2 * i].events = POLLIN;
		}
		if (poll(p, 1 + 2 * count, -1) < 0) continue;
		for (int i = count - 1; i >= 0; i--) {
			int ok = 1;
			if (p[1 + 2 * i].revents & (POLLIN | POLLHUP | POLLERR)) relay(cf[i], bf[i], &ok);
			if (ok && (p[2 + 2 * i].revents & (POLLIN | POLLHUP | POLLERR))) relay(bf[i], cf[i], &ok);
			if (!ok) {
				close(cf[i]); close(bf[i]);
				cf[i] = cf[count - 1]; bf[i] = bf[count - 1]; count--;
			}
		}
		if ((p[0].revents & POLLIN) && count < MAXC) {
			int c = accept(s, 0, 0), b = socket(AF_INET, SOCK_STREAM, 0);
			struct sockaddr_in t = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK), .sin_port = htons(BACKEND_PORT) };
			if (c < 0 || b < 0 || connect(b, (void *)&t, sizeof t)) { if (c >= 0) close(c); if (b >= 0) close(b); continue; }
			cf[count] = c; bf[count] = b; count++;
		}
	}
}
