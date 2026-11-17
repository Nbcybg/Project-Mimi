// The app's language (Loc) is one value for the whole process; a test that switches it must not run beside
// one that reads Thai text. The suite is small, so it runs one test at a time.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
