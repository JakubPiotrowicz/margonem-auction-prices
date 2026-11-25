/*
 * Thin layer over POSIX TCP sockets for the Duckling package `margonem-net`.
 * Duckling cannot describe `struct sockaddr_in` and its byte order conveniently,
 * so everything that touches those structures stays here.
 * Every function returns a negative value on error.
 */

#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdint.h>
#include <sys/socket.h>
#include <unistd.h>

int64_t net_listen_local(int64_t port) {
    int descriptor = socket(AF_INET, SOCK_STREAM, 0);
    if (descriptor < 0) {
        return -1;
    }

    int enabled = 1;
    setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled));

    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = htons((uint16_t)port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (bind(descriptor, (struct sockaddr *)&address, sizeof(address)) < 0
        || listen(descriptor, 16) < 0) {
        close(descriptor);
        return -1;
    }
    return descriptor;
}

int64_t net_accept(int64_t listener) {
    return accept((int)listener, NULL, NULL);
}

int64_t net_receive(int64_t descriptor, char *buffer, int64_t capacity) {
    return recv((int)descriptor, buffer, (size_t)capacity, 0);
}

int64_t net_send_all(int64_t descriptor, const char *data, int64_t length) {
    int64_t sent = 0;
    while (sent < length) {
        ssize_t written = send((int)descriptor, data + sent, (size_t)(length - sent), MSG_NOSIGNAL);
        if (written <= 0) {
            return -1;
        }
        sent += written;
    }
    return sent;
}

void net_close(int64_t descriptor) {
    close((int)descriptor);
}
