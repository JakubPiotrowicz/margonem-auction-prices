# Builds the C layer of the `net` package; `duck` links build/libnet_socket.a.
CFLAGS = -O2 -Wall -Wextra

build/libnet_socket.a: build/net_socket.o
	ar rcs $@ $<

build/net_socket.o: net_socket.c | build
	$(CC) $(CFLAGS) -c $< -o $@

build:
	mkdir -p build

clean:
	rm -rf build

.PHONY: clean
