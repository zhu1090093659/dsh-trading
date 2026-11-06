package launch

import (
	"strings"
	"testing"
)

func TestParseTokenURLTakesTheURLTokenOnly(t *testing.T) {
	cases := []struct {
		name string
		line string
		want string
		ok   bool
	}{
		{
			name: "loopback bind",
			line: "dsh web: http://127.0.0.1:51999/?token=abc123",
			want: "http://127.0.0.1:51999/?token=abc123",
			ok:   true,
		},
		{
			name: "LAN suffix after the URL",
			line: "dsh web: http://127.0.0.1:51999/?token=abc123 (LAN: http://192.168.31.50:51999/?token=abc123)",
			want: "http://127.0.0.1:51999/?token=abc123",
			ok:   true,
		},
		{
			name: "https bind",
			line: "dsh web: https://127.0.0.1:51999/?token=abc123",
			want: "https://127.0.0.1:51999/?token=abc123",
			ok:   true,
		},
		{
			name: "the host's browser line is not a URL",
			line: "dsh web: opening the default browser and waiting",
			ok:   false,
		},
		{
			name: "prefix without the URL",
			line: "dsh web: http://",
			want: "http://",
			ok:   true,
		},
		{
			name: "not anchored at the line start",
			line: "  dsh web: http://127.0.0.1:51999/?token=abc123",
			ok:   false,
		},
		{
			name: "another host line",
			line: "dsh profile: trading-web",
			ok:   false,
		},
		{name: "empty line", line: "", ok: false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := ParseTokenURL(c.line)
			if ok != c.ok {
				t.Fatalf("ok = %v, want %v (line %q)", ok, c.ok, c.line)
			}
			if got != c.want {
				t.Errorf("url = %q, want %q", got, c.want)
			}
		})
	}
}

func TestTokenURLCollectorKeepsTheNewestURLAndCanBeReset(t *testing.T) {
	var collector TokenURLCollector
	if got := collector.URL(); got != "" {
		t.Fatalf("URL = %q, want empty", got)
	}
	collector.Observe("dsh web: http://127.0.0.1:1/?token=one")
	collector.Observe("an unrelated line")
	collector.Observe("dsh web: http://127.0.0.1:2/?token=two")
	if got := collector.URL(); got != "http://127.0.0.1:2/?token=two" {
		t.Errorf("URL = %q, want the newest line's URL", got)
	}
	collector.Reset()
	if got := collector.URL(); got != "" {
		t.Errorf("URL after Reset = %q, want empty", got)
	}
}

func TestMaskTextHidesEveryTokenInALine(t *testing.T) {
	cases := []struct {
		name string
		line string
		want string
	}{
		{
			name: "the GUI url",
			line: "dsh web: http://127.0.0.1:51999/?token=abc123",
			want: "dsh web: http://127.0.0.1:51999/?token=***",
		},
		{
			name: "two urls on one line",
			line: "dsh web: http://127.0.0.1:51999/?token=abc123 (LAN: http://192.168.1.5:51999/?token=def456)",
			want: "dsh web: http://127.0.0.1:51999/?token=*** (LAN: http://192.168.1.5:51999/?token=***)",
		},
		{
			name: "query string with more parameters",
			line: "get /?token=9f8e7d6c5b4a&x=1",
			want: "get /?token=***&x=1",
		},
		{
			name: "no token at all",
			line: "dsh profile: trading-web",
			want: "dsh profile: trading-web",
		},
		{
			name: "quoted token",
			line: `token="abc123"`,
			want: "token=***",
		},
		{
			name: "empty value stays readable",
			line: "get /?token=&x=1",
			want: "get /?token=&x=1",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := MaskText(c.line); got != c.want {
				t.Errorf("MaskText(%q) = %q, want %q", c.line, got, c.want)
			}
		})
	}
}

func TestMaskTextLeavesNoTokenBehind(t *testing.T) {
	line := "dsh web: http://127.0.0.1:51999/?token=deadbeefdeadbeef (LAN: http://192.168.1.5:51999/?token=cafebabecafebabe)"
	masked := MaskText(line)
	for _, token := range []string{"deadbeefdeadbeef", "cafebabecafebabe"} {
		if strings.Contains(masked, token) {
			t.Fatalf("MaskText(%q) = %q, still carries %q", line, masked, token)
		}
	}
}

func TestOrigin(t *testing.T) {
	cases := []struct {
		url  string
		want string
		ok   bool
	}{
		{url: "http://127.0.0.1:51999/?token=abc", want: "http://127.0.0.1:51999", ok: true},
		{url: "http://127.0.0.1:51999", want: "http://127.0.0.1:51999", ok: true},
		{url: "HTTP://127.0.0.1:51999/x", want: "http://127.0.0.1:51999", ok: true},
		{url: "not a url", ok: false},
		{url: "http://", ok: false},
	}
	for _, c := range cases {
		got, err := Origin(c.url)
		if c.ok != (err == nil) {
			t.Fatalf("Origin(%q) err = %v, want ok=%v", c.url, err, c.ok)
		}
		if got != c.want {
			t.Errorf("Origin(%q) = %q, want %q", c.url, got, c.want)
		}
	}
}
