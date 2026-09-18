package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"sync"
)

// WithGzip: the repo payload is ~170 KB of JSON that compresses to ~32 KB. Over a tunnel
// that is the difference between an instant load and a visible wait.
var gzipPool = sync.Pool{
	New: func() any {
		w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
		return w
	},
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) { return w.gz.Write(b) }

// WithGzip compresses text responses for clients that accept it.
func WithGzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") || !compressible(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		gz := gzipPool.Get().(*gzip.Writer)
		defer gzipPool.Put(gz)
		gz.Reset(w)
		defer gz.Close()

		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		// Length refers to the identity body and no longer holds once encoded.
		w.Header().Del("Content-Length")
		next.ServeHTTP(&gzipResponseWriter{ResponseWriter: w, gz: gz}, r)
	})
}

// compressible skips assets that are already compressed, where a second pass
// only costs CPU.
func compressible(path string) bool {
	for _, ext := range []string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2", ".gz", ".zip"} {
		if strings.HasSuffix(path, ext) {
			return false
		}
	}
	return true
}
