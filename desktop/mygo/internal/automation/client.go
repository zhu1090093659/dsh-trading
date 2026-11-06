// Package automation is this shell's client of the mygo automation plugin.
//
// The plugin listens on the Unix domain socket the environment variable
// MYGO_AUTOMATION names, and answers newline-delimited JSON: one request per
// line, its answer on the next line, in order. It is part of the app only when
// the build kept the inspector (mygo build -debug, or MYGO_INSPECTOR=1 mygo
// build): a release build leaves it out and says so on stderr when
// MYGO_AUTOMATION is set.
//
// A window of native UI answers tree with its accessibility elements. This
// shell's windows show the GUI's web page instead, so tree answers unsupported
// there and Eval is the way in (see desktop/README.md).
package automation

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// Env names the socket the app listens on.
const Env = "MYGO_AUTOMATION"

// The codes the app answers a failed request with, as protocol.go names them.
const (
	CodeParse          = "parse_error"
	CodeInvalidRequest = "invalid_request"
	CodeUnknownMethod  = "unknown_method"
	CodeNoWindow       = "no_window"
	CodeNoElement      = "no_element"
	CodeUnsupported    = "unsupported"
	CodeTimeout        = "timeout"
	CodeFailed         = "failed"
)

// Error is a request the app refused or could not perform.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error renders the failure the way the app's own log does.
func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Is reports whether err is the app's failure with the given code.
func Is(err error, code string) bool {
	var failure *Error
	return errors.As(err, &failure) && failure.Code == code
}

// Rect is a window's frame, in the screen's coordinates.
type Rect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Window is one window of the running app.
type Window struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
	// Kind is "content" for a window of native UI and "page" for a web page,
	// which is what this shell's window is.
	Kind          string `json:"kind"`
	URL           string `json:"url,omitempty"`
	Bounds        Rect   `json:"bounds"`
	ContentBounds Rect   `json:"contentBounds"`
	Focused       bool   `json:"focused"`
	Visible       bool   `json:"visible"`
}

// Capture is a window's frame as a PNG image.
type Capture struct {
	PNG           []byte
	Width, Height int
}

// Client is one open connection to the app's socket.
type Client struct {
	conn   net.Conn
	reader *bufio.Reader

	mu   sync.Mutex
	next int
}

// Dial connects to the socket MYGO_AUTOMATION named.
func Dial(socket string) (*Client, error) {
	conn, err := net.DialTimeout("unix", socket, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("cannot open the automation socket %s: %w", socket, err)
	}
	return &Client{conn: conn, reader: bufio.NewReaderSize(conn, 64<<10)}, nil
}

// Close ends the connection.
func (c *Client) Close() error { return c.conn.Close() }

// request is one line sent to the app.
type request struct {
	ID     int    `json:"id"`
	Method string `json:"method"`
	Params any    `json:"params,omitempty"`
}

// response is the line that answers it.
type response struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *Error          `json:"error"`
}

// Call performs one request and returns the app's result verbatim.
func (c *Client) Call(method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.next++
	sent := request{ID: c.next, Method: method, Params: params}
	line, err := json.Marshal(sent)
	if err != nil {
		return nil, err
	}
	if _, err := c.conn.Write(append(line, '\n')); err != nil {
		return nil, fmt.Errorf("writing request %d (%s): %w", sent.ID, method, err)
	}
	answer, err := c.reader.ReadBytes('\n')
	if err != nil {
		return nil, fmt.Errorf("reading the answer to request %d (%s): %w", sent.ID, method, err)
	}
	var got response
	if err := json.Unmarshal(answer, &got); err != nil {
		return nil, fmt.Errorf("the answer to request %d (%s) is not JSON: %w", sent.ID, method, err)
	}
	if got.Error != nil {
		return nil, got.Error
	}
	if got.ID != sent.ID {
		return nil, fmt.Errorf("the answer to request %d (%s) carries id %d", sent.ID, method, got.ID)
	}
	return got.Result, nil
}

// windowsResult is the app's answer to windows.
type windowsResult struct {
	Windows []Window `json:"windows"`
}

// Windows lists the app's windows.
func (c *Client) Windows() ([]Window, error) {
	raw, err := c.Call("windows", nil)
	if err != nil {
		return nil, err
	}
	var result windowsResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("reading the window list: %w", err)
	}
	return result.Windows, nil
}

// Eval runs script in a page window and returns the JSON value it answered.
func (c *Client) Eval(window int, script string) (json.RawMessage, error) {
	raw, err := c.Call("eval", struct {
		Window int    `json:"window"`
		Script string `json:"script"`
	}{Window: window, Script: script})
	if err != nil {
		return nil, err
	}
	var result struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("reading the eval result: %w", err)
	}
	if len(result.Value) == 0 {
		return nil, errors.New("the app answered an eval without a value")
	}
	return result.Value, nil
}

// Tree reads a window's accessibility tree. This shell's window shows a web
// page, so the app answers CodeUnsupported here; the call stays for the drill's
// sake and says what the protocol does.
func (c *Client) Tree(window int) (json.RawMessage, error) {
	return c.Call("tree", windowParams{Window: window})
}

// Capture captures a window as a PNG image.
func (c *Client) Capture(window int) (Capture, error) {
	raw, err := c.Call("capture", windowParams{Window: window})
	if err != nil {
		return Capture{}, err
	}
	var result struct {
		PNG    []byte `json:"png"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return Capture{}, fmt.Errorf("reading the capture: %w", err)
	}
	if len(result.PNG) == 0 {
		return Capture{}, errors.New("the app answered a capture without a PNG")
	}
	return Capture{PNG: result.PNG, Width: result.Width, Height: result.Height}, nil
}

// Idle waits until the window settles, or until timeout has passed (0 waits
// without a deadline, as the protocol says).
func (c *Client) Idle(window int, timeout time.Duration) error {
	_, err := c.Call("idle", struct {
		Window  int `json:"window"`
		Timeout int `json:"timeout"`
	}{Window: window, Timeout: int(timeout / time.Millisecond)})
	return err
}

// windowParams is the params of the requests that name a window.
type windowParams struct {
	Window int `json:"window"`
}
