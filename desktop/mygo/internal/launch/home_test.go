package launch

import "testing"

// getenvFrom returns a getenv that answers with one DSH_HOME value.
func getenvFrom(value string) func(string) string {
	return func(key string) string {
		if key == "DSH_HOME" {
			return value
		}
		return ""
	}
}

func TestSelectDshHomeDefaultsToTheTradingHome(t *testing.T) {
	selection := SelectDshHome(getenvFrom(""), "/Users/zcl")
	if selection.Home != "/Users/zcl/.dsh-trading" {
		t.Errorf("Home = %q, want the built-in trading home", selection.Home)
	}
	if selection.Ignored != "" {
		t.Errorf("Ignored = %q, want empty", selection.Ignored)
	}
}

func TestSelectDshHomeIgnoresANonTradingHome(t *testing.T) {
	selection := SelectDshHome(getenvFrom("/Users/zcl/.dsh"), "/Users/zcl")
	if selection.Home != "/Users/zcl/.dsh-trading" {
		t.Errorf("Home = %q, want the built-in trading home", selection.Home)
	}
	if selection.Ignored != "/Users/zcl/.dsh" {
		t.Errorf("Ignored = %q, want the inherited host home reported back", selection.Ignored)
	}
}

func TestSelectDshHomeIgnoresABareTilde(t *testing.T) {
	// "~" carries no *-trading marker either, so the shell keeps its own home
	// and says what it ignored, exactly as the Electron helper does.
	selection := SelectDshHome(getenvFrom("~"), "/Users/zcl")
	if selection.Home != "/Users/zcl/.dsh-trading" {
		t.Errorf("Home = %q, want the built-in trading home", selection.Home)
	}
	if selection.Ignored != "~" {
		t.Errorf("Ignored = %q, want %q", selection.Ignored, "~")
	}
}

func TestSelectDshHomeAdoptsATradingHome(t *testing.T) {
	cases := []struct{ configured, want string }{
		{"/tmp/dsh-mygo-probe-trading", "/tmp/dsh-mygo-probe-trading"},
		{"~/probe-trading", "/Users/zcl/probe-trading"},
		{"  /tmp/spaced-trading  ", "/tmp/spaced-trading"},
	}
	for _, c := range cases {
		selection := SelectDshHome(getenvFrom(c.configured), "/Users/zcl")
		if selection.Home != c.want {
			t.Errorf("SelectDshHome(%q).Home = %q, want %q", c.configured, selection.Home, c.want)
		}
		if selection.Ignored != "" {
			t.Errorf("SelectDshHome(%q).Ignored = %q, want empty", c.configured, selection.Ignored)
		}
	}
}
