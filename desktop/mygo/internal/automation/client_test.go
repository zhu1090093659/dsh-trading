//go:build !windows

// The app socket is a unix domain socket: the shell ships on macOS, and a
// Windows build has no listener for these tests to dial.
package automation

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// tinyPNG is a 1x1 PNG, which is all a decode test needs.
const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

// served is a fake app on a socket: it answers one canned line per request and
// records every request the client sent.
type served struct {
	socket string
	done   chan []map[string]any
}

// serve starts the fake app, which answers the responses in order.
func serve(t *testing.T, socket string, responses ...string) *served {
	t.Helper()
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("listening on %s err = %v", socket, err)
	}
	fake := &served{socket: socket, done: make(chan []map[string]any, 1)}
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			fake.done <- nil
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		var requests []map[string]any
		for i := 0; i < len(responses); i++ {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				break
			}
			var request map[string]any
			if err := json.Unmarshal(line, &request); err != nil {
				break
			}
			requests = append(requests, request)
			if _, err := conn.Write([]byte(responses[i] + "\n")); err != nil {
				break
			}
		}
		fake.done <- requests
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return fake
}

// answered waits for the fake app to see the client's requests.
func (s *served) answered(t *testing.T) []map[string]any {
	t.Helper()
	select {
	case requests := <-s.done:
		return requests
	case <-time.After(5 * time.Second):
		t.Fatal("the fake app never finished answering")
		return nil
	}
}

// dial opens one client on the fake app's socket.
func dial(t *testing.T, socket string) *Client {
	t.Helper()
	client, err := Dial(socket)
	if err != nil {
		t.Fatalf("Dial(%s) err = %v", socket, err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestClientSpeaksTheProtocol(t *testing.T) {
	decodedPNG, err := base64.StdEncoding.DecodeString(tinyPNG)
	if err != nil {
		t.Fatalf("decoding the fixture PNG err = %v", err)
	}
	socket := filepath.Join(t.TempDir(), "app.sock")
	fake := serve(t, socket,
		`{"id":1,"result":{"windows":[{"id":7,"title":"DSH Trading","kind":"page","url":"http://127.0.0.1:51234/","bounds":{"x":0,"y":0,"width":1440,"height":900},"contentBounds":{"x":0,"y":0,"width":1440,"height":900},"focused":true,"visible":true}]}}`,
		`{"id":2,"result":{"value":{"readyState":"complete","title":"DSH Trading"}}}`,
		`{"id":3,"result":{"png":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","width":1440,"height":900}}`,
		`{"id":4,"result":{}}`,
	)
	client := dial(t, socket)

	windows, err := client.Windows()
	if err != nil {
		t.Fatalf("Windows err = %v", err)
	}
	if len(windows) != 1 {
		t.Fatalf("Windows = %v, want the app's one window", windows)
	}
	window := windows[0]
	if window.ID != 7 || window.Kind != "page" || window.URL != "http://127.0.0.1:51234/" {
		t.Errorf("window = %+v, want the page window the app reported", window)
	}
	if !window.Focused || !window.Visible || window.Bounds.Width != 1440 {
		t.Errorf("window = %+v, want its state and frame read", window)
	}

	value, err := client.Eval(7, "document.readyState")
	if err != nil {
		t.Fatalf("Eval err = %v", err)
	}
	if want := `{"readyState":"complete","title":"DSH Trading"}`; string(value) != want {
		t.Errorf("Eval value = %s, want %s", value, want)
	}

	capture, err := client.Capture(7)
	if err != nil {
		t.Fatalf("Capture err = %v", err)
	}
	if string(capture.PNG) != string(decodedPNG) {
		t.Errorf("Capture PNG = %d bytes, want the app's %d", len(capture.PNG), len(decodedPNG))
	}
	if capture.Width != 1440 || capture.Height != 900 {
		t.Errorf("Capture size = %dx%d, want 1440x900", capture.Width, capture.Height)
	}

	if err := client.Idle(7, 2*time.Second); err != nil {
		t.Fatalf("Idle err = %v", err)
	}

	requests := fake.answered(t)
	if len(requests) != 4 {
		t.Fatalf("the app saw %d requests, want 4: %v", len(requests), requests)
	}
	methods := []string{"windows", "eval", "capture", "idle"}
	for i, method := range methods {
		if got := requests[i]["method"]; got != method {
			t.Errorf("request %d method = %v, want %s", i, got, method)
		}
		if got := requests[i]["id"]; got != float64(i+1) {
			t.Errorf("request %d id = %v, want %d", i, got, i+1)
		}
	}
	evalParams, ok := requests[1]["params"].(map[string]any)
	if !ok || evalParams["window"] != float64(7) || evalParams["script"] != "document.readyState" {
		t.Errorf("eval params = %v, want the window and the script", requests[1]["params"])
	}
	idleParams, ok := requests[3]["params"].(map[string]any)
	if !ok || idleParams["window"] != float64(7) || idleParams["timeout"] != float64(2000) {
		t.Errorf("idle params = %v, want window 7 and 2000ms", requests[3]["params"])
	}
}

func TestClientReportsTheAppsCodes(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "app.sock")
	fake := serve(t, socket,
		`{"id":1,"error":{"code":"unsupported","message":"window 7 shows a web page: use eval"}}`,
	)
	client := dial(t, socket)

	_, err := client.Tree(7)
	if err == nil {
		t.Fatal("Tree on a page window err = nil, want the app's unsupported")
	}
	if !Is(err, CodeUnsupported) {
		t.Errorf("Tree err = %v, want an unsupported failure", err)
	}
	var failure *Error
	if !errors.As(err, &failure) {
		t.Fatalf("Tree err = %v, want *Error", err)
	}
	if failure.Code != CodeUnsupported || failure.Message != "window 7 shows a web page: use eval" {
		t.Errorf("failure = %+v, want the app's code and message", failure)
	}
	if got := err.Error(); got != "unsupported: window 7 shows a web page: use eval" {
		t.Errorf("err.Error() = %q, want the code and message", got)
	}
	fake.answered(t)
}

func TestClientRejectsAnAnswerItCannotTrust(t *testing.T) {
	cases := []struct {
		name     string
		response string
		want     string
	}{
		{"another request's id", `{"id":9,"result":{}}`, "carries id 9"},
		{"not JSON", `not json`, "is not JSON"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			socket := filepath.Join(t.TempDir(), "app.sock")
			fake := serve(t, socket, c.response)
			client := dial(t, socket)
			if _, err := client.Call("windows", nil); err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("Call err = %v, want it to mention %q", err, c.want)
			}
			fake.answered(t)
		})
	}
}

func TestDialReportsAMissingSocket(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "absent.sock")
	if _, err := Dial(socket); err == nil {
		t.Fatalf("Dial(%s) err = nil, want it to name the socket", socket)
	} else if !strings.Contains(err.Error(), socket) {
		t.Errorf("Dial err = %v, want it to name the socket", err)
	}
	if _, err := os.Stat(socket); !os.IsNotExist(err) {
		t.Errorf("the failed dial created %s (stat err = %v)", socket, err)
	}
}
