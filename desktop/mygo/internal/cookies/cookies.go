// Package cookies prunes the browser-session cookies earlier launches left
// behind, which is the 431 fix desktop/src/main.cjs:pruneStaleAuthCookies
// carries for Electron.
package cookies

import "strings"

// AuthPrefix is the cookie the host issues for its own request authority. The
// name derives from the request authority (127.0.0.1:<port>) and the shell
// takes a fresh port per launch, so every launch leaves one more cookie behind
// and nothing retires it. Chromium replays the whole jar on every request; once
// the cookie header plus the multi-kilobyte /plugins/?? combo URL overruns the
// host's request-header budget the host answers 431 for the client batch and
// the GUI reports "Failed to load plugins" (measured 2026-09-11: 63 cookies =
// 14 KiB beside a 2.8 KiB URL).
const AuthPrefix = "dsh-auth-"

// Cookie is the part of a cookie this package needs: Delete matches on name,
// domain and path, and nothing else.
type Cookie struct {
	Name   string
	Domain string
	Path   string
}

// Store is the cookie jar the shell prunes: the app's own webview session.
type Store interface {
	// List returns the cookies a request to url sends.
	List(url string) ([]Cookie, error)
	// Delete removes one cookie.
	Delete(c Cookie) error
}

// Result reports one prune. A failed delete does not stop the others: a stale
// jar must never block a launch, and the header budget covers a jar that grew
// past what pruning could reach.
type Result struct {
	// Before is how many cookies the jar held for the origin.
	Before int
	// Pruned is how many dsh-auth-* cookies were deleted.
	Pruned int
	// Err is the first failure, nil when the prune went through.
	Err error
}

// IsAuthCookie reports whether a cookie name is one of the host's own session
// cookies. Prefix match only, case-sensitive, as the Electron shell filters.
func IsAuthCookie(name string) bool { return strings.HasPrefix(name, AuthPrefix) }

// Prune deletes every dsh-auth-* cookie a request to url would send.
func Prune(store Store, url string) Result {
	jar, err := store.List(url)
	if err != nil {
		return Result{Err: err}
	}
	result := Result{Before: len(jar)}
	for _, cookie := range jar {
		if !IsAuthCookie(cookie.Name) {
			continue
		}
		if err := store.Delete(cookie); err != nil {
			if result.Err == nil {
				result.Err = err
			}
			continue
		}
		result.Pruned++
	}
	return result
}

// Count is how many cookies the jar holds for url.
func Count(store Store, url string) (int, error) {
	jar, err := store.List(url)
	if err != nil {
		return 0, err
	}
	return len(jar), nil
}
