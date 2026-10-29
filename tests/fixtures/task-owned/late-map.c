/* Test double for a llama.cpp server that listens first and maps the model afterwards, as the real one does while it
   loads: it binds 127.0.0.1:--port, waits MAP_DELAY_MS, maps --model (only when MAP_DELAY_MS is non-negative) and idles. */
#include <arpa/inet.h>
#include <fcntl.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>
#include <stdlib.h>
#ifndef MAP_DELAY_MS
#error MAP_DELAY_MS
#endif
int main(int n, char **v) {
	char *model = 0; int port = 0;
	for (int i = 1; i + 1 < n; i++) {
		if (!strcmp(v[i], "--model")) model = v[i + 1];
		if (!strcmp(v[i], "--port")) port = atoi(v[i + 1]);
	}
	if (!model || !port) return 2;
	int s = socket(AF_INET, SOCK_STREAM, 0), one = 1;
	setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
	struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK), .sin_port = htons(port) };
	if (bind(s, (void *)&a, sizeof a) || listen(s, 16)) return 4;
	if (MAP_DELAY_MS >= 0) {
		usleep((useconds_t)MAP_DELAY_MS * 1000);
		int f = open(model, O_RDONLY);
		if (f < 0 || mmap(0, 4096, PROT_READ, MAP_PRIVATE, f, 0) == MAP_FAILED) return 3;
	}
	for (;;) pause();
}
