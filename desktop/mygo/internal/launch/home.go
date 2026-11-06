package launch

import (
	"path/filepath"
	"strings"
)

// TradingHomeMarker marks a DSH home as this shell's own. It is the same
// criterion the CLI wrapper uses (`case "${DSH_HOME:-}" in *-trading*`) and
// the same one desktop/src/runtime.cjs:isTradingHomePath applies, so a probe
// home has to be named *-trading to be adopted.
const TradingHomeMarker = "-trading"

// HomeSelection is the DSH home this shell manages, plus the explicit DSH_HOME
// it deliberately ignored (Desktop's inherited `DSH_HOME=~/.dsh` must never
// become the trading home: 2026-10-14 shipped trading data into the host home).
type HomeSelection struct {
	Home    string
	Ignored string
}

// SelectDshHome resolves the DSH home from the environment, mirroring
// desktop/src/runtime.cjs:selectDshHome. An empty or non-trading DSH_HOME
// falls back to ~/.dsh-trading; a *-trading one is adopted with ~ expanded.
func SelectDshHome(getenv func(string) string, homedir string) HomeSelection {
	tradingHome := filepath.Join(homedir, ".dsh-trading")
	configured := strings.TrimSpace(getenv("DSH_HOME"))
	if configured == "" {
		return HomeSelection{Home: tradingHome}
	}
	if !strings.Contains(configured, TradingHomeMarker) {
		return HomeSelection{Home: tradingHome, Ignored: configured}
	}
	if rest, ok := strings.CutPrefix(configured, "~/"); ok {
		return HomeSelection{Home: filepath.Join(homedir, rest)}
	}
	if rest, ok := strings.CutPrefix(configured, `~\`); ok {
		return HomeSelection{Home: filepath.Join(homedir, rest)}
	}
	abs, err := filepath.Abs(configured)
	if err != nil {
		return HomeSelection{Home: configured}
	}
	return HomeSelection{Home: abs}
}
