package server

import "errors"

// ErrNoRepos is returned when the server is configured with no repositories.
var ErrNoRepos = errors.New("quanticode: at least one repository is required")

// NotARepoError reports a configured directory that is not a git repository.
type NotARepoError struct{ Dir string }

func (e *NotARepoError) Error() string { return "quanticode: not a git repository: " + e.Dir }

// BadNameError reports a repository name that slugifies to nothing.
type BadNameError struct{ Name string }

func (e *BadNameError) Error() string {
	return "quanticode: repository name has no usable characters: " + e.Name
}

// DuplicateRepoError reports two repositories whose names slugify identically,
// which would make one of them unreachable.
type DuplicateRepoError struct{ Slug string }

func (e *DuplicateRepoError) Error() string {
	return "quanticode: duplicate repository slug: " + e.Slug
}
