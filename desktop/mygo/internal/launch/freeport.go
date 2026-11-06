package launch

import "net"

// FindFreePort asks the OS for a free loopback port. The shell picks the port,
// so it knows the GUI origin (and can trust it) before the host prints anything.
func FindFreePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		return 0, err
	}
	return port, nil
}
