const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const typedResourceId = (zone,id) => (['memo','announcement'].includes(zone) && typeof id === 'string' && (UUID.test(id)||id==='demo'||id==='notice-demo')) ? zone+':'+id : null;
export const memoOwnerAllowed=(userId,ownerId)=>typeof userId==='string'&&UUID.test(userId)&&ownerId===userId;
export const trustedInstructorMetadata=(meta)=>Boolean(meta&&typeof meta==='object'&&!Array.isArray(meta)&&(meta.role==='instructor'||(Array.isArray(meta.roles)&&meta.roles.includes('instructor'))));
export const mayEditAnnouncement=({identity,verifiedAppMetadata,storedOwnerId})=>identity?.kind==='student'&&memoOwnerAllowed(identity.userId,storedOwnerId)&&trustedInstructorMetadata(verifiedAppMetadata);
