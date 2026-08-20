package main

import "strings"

// lowerKey lowercases for lookup while callers keep the original for
// single-character keys.
func lowerKey(key string) string { return strings.ToLower(strings.TrimSpace(key)) }

// fnKeyNumber returns the function-key number for names like "f5" (1..12).
func fnKeyNumber(lower string) (string, bool) {
	if len(lower) > 1 && lower[0] == 'f' {
		num := lower[1:]
		if len(num) >= 1 && len(num) <= 2 {
			for _, c := range num {
				if c < '0' || c > '9' {
					return "", false
				}
			}
			n := 0
			for _, c := range num {
				n = n*10 + int(c-'0')
			}
			if n >= 1 && n <= 12 {
				return num, true
			}
		}
	}
	return "", false
}
