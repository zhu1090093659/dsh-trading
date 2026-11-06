package cookies

import (
	"errors"
	"testing"
)

// fakeStore is a cookie jar held in memory, the seam that keeps Prune testable
// without a webview.
type fakeStore struct {
	jar     []Cookie
	deleted []string
	listErr error
	// failOn makes Delete fail for these cookie names.
	failOn map[string]error
}

func (s *fakeStore) List(url string) ([]Cookie, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	return append([]Cookie(nil), s.jar...), nil
}

func (s *fakeStore) Delete(c Cookie) error {
	if err, ok := s.failOn[c.Name]; ok {
		return err
	}
	s.deleted = append(s.deleted, c.Name)
	kept := s.jar[:0]
	for _, cookie := range s.jar {
		if cookie.Name != c.Name {
			kept = append(kept, cookie)
		}
	}
	s.jar = kept
	return nil
}

func TestIsAuthCookieMatchesOnlyTheHostPrefix(t *testing.T) {
	for _, name := range []string{"dsh-auth-abc", "dsh-auth-127.0.0.1:0", "dsh-auth-"} {
		if !IsAuthCookie(name) {
			t.Errorf("IsAuthCookie(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"dsh-auth", "auth-dsh-1", "Dsh-Auth-1", "dsh-session", "x", ""} {
		if IsAuthCookie(name) {
			t.Errorf("IsAuthCookie(%q) = true, want false", name)
		}
	}
}

func TestPruneDeletesOnlyStaleAuthCookies(t *testing.T) {
	store := &fakeStore{jar: []Cookie{
		{Name: "dsh-auth-51089", Domain: "127.0.0.1"},
		{Name: "theme", Domain: "127.0.0.1"},
		{Name: "dsh-auth-50833", Domain: "127.0.0.1"},
	}}
	result := Prune(store, "http://127.0.0.1:51999/")
	if result.Err != nil {
		t.Fatalf("Prune err = %v, want nil", result.Err)
	}
	if result.Before != 3 {
		t.Errorf("Before = %d, want 3", result.Before)
	}
	if result.Pruned != 2 {
		t.Errorf("Pruned = %d, want 2", result.Pruned)
	}
	if len(store.jar) != 1 || store.jar[0].Name != "theme" {
		t.Errorf("jar after prune = %v, want the theme cookie alone", store.jar)
	}
}

func TestPruneKeepsGoingWhenADeleteFails(t *testing.T) {
	broken := errors.New("remove failed")
	store := &fakeStore{
		jar: []Cookie{
			{Name: "dsh-auth-1", Domain: "127.0.0.1"},
			{Name: "dsh-auth-2", Domain: "127.0.0.1"},
			{Name: "dsh-auth-3", Domain: "127.0.0.1"},
		},
		failOn: map[string]error{"dsh-auth-2": broken},
	}
	result := Prune(store, "http://127.0.0.1:51999/")
	if !errors.Is(result.Err, broken) {
		t.Fatalf("Err = %v, want %v", result.Err, broken)
	}
	if result.Pruned != 2 {
		t.Errorf("Pruned = %d, want 2", result.Pruned)
	}
	if len(store.deleted) != 2 {
		t.Errorf("deleted = %v, want the two working cookies", store.deleted)
	}
}

func TestPruneReportsAListFailure(t *testing.T) {
	broken := errors.New("cookie store unavailable")
	result := Prune(&fakeStore{listErr: broken}, "http://127.0.0.1:51999/")
	if !errors.Is(result.Err, broken) {
		t.Fatalf("Err = %v, want %v", result.Err, broken)
	}
	if result.Before != 0 || result.Pruned != 0 {
		t.Errorf("Before/Pruned = %d/%d, want 0/0", result.Before, result.Pruned)
	}
}

func TestCountReadsTheJar(t *testing.T) {
	store := &fakeStore{jar: []Cookie{{Name: "dsh-auth-1"}, {Name: "dsh-auth-2"}}}
	count, err := Count(store, "http://127.0.0.1:51999/")
	if err != nil {
		t.Fatalf("Count err = %v, want nil", err)
	}
	if count != 2 {
		t.Errorf("count = %d, want 2", count)
	}
	if _, err := Count(&fakeStore{listErr: errors.New("nope")}, "http://127.0.0.1:51999/"); err == nil {
		t.Error("Count err = nil, want the store failure")
	}
}
