import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {CHARACTERS} from '../src/simulation.js';
globalThis.ProgressEvent ??= class ProgressEvent { constructor(type,init){Object.assign(this,{type,...init})} };
for(const id of ['Taipei101',...CHARACTERS.map(c=>c.id)])test(`GLB parses with geometry: ${id}`,async()=>{const bytes=fs.readFileSync(new URL(`../public/models/${id}.glb`,import.meta.url));const data=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);const gltf=await new GLTFLoader().parseAsync(data,'');const box=new THREE.Box3().setFromObject(gltf.scene);let meshes=0;gltf.scene.traverse(o=>{if(o.isMesh)meshes++});assert(meshes>0);const size=box.getSize(new THREE.Vector3());assert(size.y>0);console.log(`${id}: ${meshes} meshes; bounds ${size.toArray().map(x=>x.toFixed(2)).join(' × ')}`);});
const ORIGINAL_MODEL_SHA256 = {
  "Charizard": "0a67f54c7e3a387d497dbd496dd66949a9110a76b7016aef87e92704db8effa2",
  "Garchomp": "311c1b59d04f2840895c2aee029cdeffedcbae5718f0c64295e40ac4bd1168bd",
  "Gardevoir": "2005f05bc1f79993e5af4636e302cafab83e22c01357379c919118d2cb7b5c5d",
  "Gengar": "a6f674712450088408f6386c5b61226c5cf45faf8541e0b39dfc0acfbb4e673b",
  "Greninja": "ef8e6a0a6a402f3d9f1c6633df3083f97411a6af82871355d0a356419dae9851",
  "Lucario": "0eba494a92b695651d8bbb449d50316ab31daa404d46b1257990ec18a115782d",
  "Mimikyu": "92f21dfc099096c6a2489a677da788b77cbdcd708eea2eb16559c6554ac4262a",
  "Rayquaza": "b594d3a79237e6265dc5d80fcd271913ba8c58baef63a42cd5dde434bbad769d",
  "Sylveon": "f04f0c94540f6a15c19914697e02604f909a1990f0ae14d3efda7ba51896a200",
  "Taipei101": "c8bcf299e42f43accf7b859de64159d3e93b80cd3ba925b1eecaa057c501fb42",
  "Umbreon": "8da2f0f76569b31f5edd3b70526e7c4da6ca5c99c8bf23d55b09f14421afed97"
};
test('all models match the original supplied SHA256 fingerprints',()=>{for(const [id,expected] of Object.entries(ORIGINAL_MODEL_SHA256)){const bytes=fs.readFileSync(new URL(`../public/models/${id}.glb`,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,`${id} model changed`);}});
