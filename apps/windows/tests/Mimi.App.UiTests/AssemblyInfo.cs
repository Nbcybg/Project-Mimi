// Each test launches the real Mimi.exe and drives it through UI Automation: several app
// instances at once thrash the machine and make sign-in time out, so they run one by one.
[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]
