package launch

import (
	"fmt"
	"net/url"
	"strings"
	"sync"
)

// TokenLinePrefix starts the one host line that carries the launch token. The
// shell never builds that URL itself: the token is per process and only the
// host that issued it can print it.
const TokenLinePrefix = "dsh web: "

// maskedValue replaces the token in anything the shell logs.
const maskedValue = "***"

// maskValueStops end a token value: the characters that follow it in host
// output — a space before the next field, the query separator, the closing
// parenthesis of a "(LAN: …)" suffix.
const maskValueStops = " \t\r\n&#),;>"

// ParseTokenURL extracts the tokenized GUI URL from one host output line,
// mirroring the /^dsh web: (https?:\/\/\S+)/ pattern of
// desktop/src/runtime.cjs:parseTokenUrlLine. Only the URL token is taken, not
// the rest of the line: a non-loopback bind appends " (LAN: <url>)" to it,
// while the host's other "dsh web: opening the default browser…" line matches
// the prefix but not the scheme.
func ParseTokenURL(line string) (string, bool) {
	rest, ok := strings.CutPrefix(line, TokenLinePrefix)
	if !ok || rest == "" {
		return "", false
	}
	end := strings.IndexAny(rest, " \t\r\n")
	if end < 0 {
		end = len(rest)
	}
	candidate := rest[:end]
	if !strings.HasPrefix(candidate, "http://") && !strings.HasPrefix(candidate, "https://") {
		return "", false
	}
	return candidate, true
}

// TokenURLCollector keeps the tokenized URL of the host that is booting now.
//
// The URL belongs to one host process, so a boot must only read what its own
// host printed: reusing the previous boot's line loads a port nobody serves
// (measured on the Electron shell 2026-10-15, ERR_CONNECTION_REFUSED on the
// dead host's port while the restarted one was serving another).
type TokenURLCollector struct {
	mu  sync.Mutex
	url string
}

// Reset forgets the URL of the previous host.
func (c *TokenURLCollector) Reset() {
	c.mu.Lock()
	c.url = ""
	c.mu.Unlock()
}

// Observe takes the URL out of one host output line, if it carries one.
func (c *TokenURLCollector) Observe(line string) {
	parsed, ok := ParseTokenURL(line)
	if !ok {
		return
	}
	c.mu.Lock()
	c.url = parsed
	c.mu.Unlock()
}

// URL is the tokenized URL the current host printed, or "".
func (c *TokenURLCollector) URL() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.url
}

// MaskText hides the launch token in one line of host output before it is
// logged. The token is the only credential those lines carry, and the log file
// outlives the process that printed it.
func MaskText(line string) string {
	const key = "token="
	if !strings.Contains(line, key) {
		return line
	}
	var b strings.Builder
	for {
		i := strings.Index(line, key)
		if i < 0 {
			b.WriteString(line)
			return b.String()
		}
		b.WriteString(line[:i+len(key)])
		line = line[i+len(key):]
		end := strings.IndexAny(line, maskValueStops)
		if end < 0 {
			end = len(line)
		}
		// An empty value is not a token; the stops stay in the line.
		if end > 0 {
			b.WriteString(maskedValue)
		}
		line = line[end:]
	}
}

// Origin is the scheme://host part of a URL, which is what the window trusts
// for its Go bridge and what the cookie jar is scoped to.
func Origin(rawURL string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("cannot read the origin of %s: %w", MaskText(rawURL), err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("cannot read the origin of %s", MaskText(rawURL))
	}
	return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host), nil
}
