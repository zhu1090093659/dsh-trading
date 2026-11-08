package launch

import (
	"path/filepath"
	"testing"
)

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
	home := t.TempDir()
	selection := SelectDshHome(getenvFrom(""), home)
	if want := filepath.Join(home, ".dsh-trading"); selection.Home != want {
		t.Errorf("Home = %q, want the built-in trading home %q", selection.Home, want)
	}
	if selection.Ignored != "" {
		t.Errorf("Ignored = %q, want empty", selection.Ignored)
	}
}

func TestSelectDshHomeIgnoresANonTradingHome(t *testing.T) {
	home := t.TempDir()
	inherited := filepath.Join(t.TempDir(), "host-home")
	selection := SelectDshHome(getenvFrom(inherited), home)
	if want := filepath.Join(home, ".dsh-trading"); selection.Home != want {
		t.Errorf("Home = %q, want the built-in trading home %q", selection.Home, want)
	}
	if selection.Ignored != inherited {
		t.Errorf("Ignored = %q, want the inherited host home reported back", selection.Ignored)
	}
}

func TestSelectDshHomeIgnoresABareTilde(t *testing.T) {
	// "~" carries no *-trading marker either, so the shell keeps its own home
	// and says what it ignored, exactly as the Electron helper does.
	home := t.TempDir()
	selection := SelectDshHome(getenvFrom("~"), home)
	if want := filepath.Join(home, ".dsh-trading"); selection.Home != want {
		t.Errorf("Home = %q, want the built-in trading home %q", selection.Home, want)
	}
	if selection.Ignored != "~" {
		t.Errorf("Ignored = %q, want %q", selection.Ignored, "~")
	}
}

func TestSelectDshHomeAdoptsATradingHome(t *testing.T) {
	home := t.TempDir()
	probe := filepath.Join(t.TempDir(), "dsh-mygo-probe-trading")
	spaced := filepath.Join(t.TempDir(), "spaced-trading")
	cases := []struct{ configured, want string }{
		{probe, probe},
		{"~/probe-trading", filepath.Join(home, "probe-trading")},
		{"  " + spaced + "  ", spaced},
	}
	for _, c := range cases {
		selection := SelectDshHome(getenvFrom(c.configured), home)
		if selection.Home != c.want {
			t.Errorf("SelectDshHome(%q).Home = %q, want %q", c.configured, selection.Home, c.want)
		}
		if selection.Ignored != "" {
			t.Errorf("SelectDshHome(%q).Ignored = %q, want empty", c.configured, selection.Ignored)
		}
	}
}
