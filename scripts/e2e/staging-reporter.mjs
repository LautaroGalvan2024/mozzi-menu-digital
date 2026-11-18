export default class StagingReporter {
  total = 0
  passed = 0
  failed = 0
  skipped = 0
  onBegin(_config, suite) { this.total = suite.allTests().length }
  onTestEnd(_test, result) {
    if (result.status === 'passed') this.passed++
    else if (result.status === 'skipped') this.skipped++
    else this.failed++
    console.log(`STAGING_ACCEPTANCE test ${result.status}`)
  }
  onStdOut() {}
  onStdErr() {}
  onError() { console.log('STAGING_ACCEPTANCE runner error') }
  onEnd(result) {
    console.log(`STAGING_ACCEPTANCE summary total=${this.total} passed=${this.passed} failed=${this.failed} skipped=${this.skipped}`)
    return { status: result.status === 'passed' && this.total === 4 && this.passed === 4 && this.failed === 0 && this.skipped === 0 ? 'passed' : 'failed' }
  }
}
