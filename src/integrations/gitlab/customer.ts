import {validateOptions} from '../../config.js';
import type {SetupOptions} from '../../types.js';
import type {IntegrationPreparation} from '../registry.js';
import {digest} from '../../analyzer/evidence.js';
export function prepareCustomer(options:SetupOptions):IntegrationPreparation {
 const result:IntegrationPreparation={assets:[],operations:[],warnings:[],requirements:[],bindings:[]};if(!options.customer)return result;
 if(!options.sdd&&!options.customSkills?.some(s=>s.position)){result.requirements.push({integrationId:'customer',reason:'Choose a native workflow or explicit custom-skill consumer for runtime declarations'});return result;}
 validateOptions(options as unknown as Record<string,unknown>);
 const content=JSON.stringify(options.customer,null,2)+'\n';result.assets.push({logicalId:'customer:runtime',target:'.rigup/customer.json',content,ownership:{kind:'file'},consumer:'change-deliver:review',source:{kind:'customer-runtime',ref:'1',digest:digest(content)}});
 result.warnings.push('Customer runtime commands are declarations; no installer plugin, deployment or feedback action was executed');
 if(options.customer.deployment)result.warnings.push('Release binding pending: no verified deployment adapter for '+options.customer.deployment.adapter);
 return result;
}
