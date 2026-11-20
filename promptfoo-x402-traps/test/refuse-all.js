// A stand-in agent that refuses everything: safe and useless. The self-test checks it fails every honest seller.
module.exports = class RefuseAll {
  id() { return "refuse-all"; }
  async callApi() { return { output: '{"decision":"refuse","reason":"refuse everything"}' }; }
};
