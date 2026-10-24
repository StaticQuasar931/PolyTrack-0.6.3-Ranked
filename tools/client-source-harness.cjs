const vm=require('node:vm');
// Keep extracted production functions wired to their real shared transport.
module.exports=function createClientSourceRunner(source){
  return function runClientSource(code,context,...options){
    if(code.includes('rankedFetch(')&&!code.includes('function rankedFetch(')){
      const helper=source.match(/  function rankedFetch\([\s\S]*?\r?\n  \}/);
      if(!helper)throw Error('Missing production Ranked transport');
      context.Headers=Headers;
      vm.runInContext(helper[0],context);
    }
    return vm.runInContext(code,context,...options);
  };
};
