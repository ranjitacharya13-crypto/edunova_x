"""Original, low-poly teaching schematic. No external assets or student data.
Run with Python 3 to regenerate the small GLB. Geometry is intentionally
schematic/enlarged, not an anatomical or medical model. CC0 geometry.
"""
import json, math, struct
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
positions, normals, indices = [], [], []
rows, cols = 12, 24
for i in range(rows + 1):
    lat = math.pi * i / rows
    for j in range(cols + 1):
        phi = 2 * math.pi * j / cols
        v = [math.sin(lat)*math.cos(phi), math.cos(lat), math.sin(lat)*math.sin(phi)]
        positions += v; normals += v
for i in range(rows):
    for j in range(cols):
        a = i*(cols+1)+j; b = a+cols+1
        indices += [a,b,a+1,b,b+1,a+1]
# Rear hemisphere shell opens toward camera (+z) to expose the internal optics.
cut_indices = []
for n in range(0,len(indices),3):
    tri=indices[n:n+3]
    if sum(positions[k*3+2] for k in tri)/3 <= 0.01: cut_indices += tri
blocks = [struct.pack('<%sf'%len(positions), *positions), struct.pack('<%sf'%len(normals), *normals), struct.pack('<%sH'%len(indices),*indices), struct.pack('<%sH'%len(cut_indices),*cut_indices)]
blob=b''; views=[]
for block in blocks:
    blob += b'\0' * ((-len(blob))%4)
    views.append({'buffer':0,'byteOffset':len(blob),'byteLength':len(block)})
    blob+=block
materials=[];meshes=[];nodes=[]
parts=[
 ('Sclera',[.86,.9,.96,1],[.13,.13,.13],[0,0,0],3),
 ('Retina',[.94,.36,.28,1],[.124,.124,.124],[0,0,0],3),
 ('Lens',[.39,.81,.96,1],[.025,.065,.045],[.065,0,0],2),
 ('Iris',[.24,.46,.68,1],[.009,.067,.042],[.106,0,0],2),
 ('Pupil',[.03,.06,.1,1],[.010,.025,.026],[.117,0,.009],2),
 ('Optic nerve',[.97,.76,.38,1],[.058,.020,.02],[-.169,-.012,0],2),
]
for name,color,scale,translation,idx in parts:
    materials.append({'name':name,'pbrMetallicRoughness':{'baseColorFactor':color,'metallicFactor':0,'roughnessFactor':.8},'doubleSided':True})
    meshes.append({'name':name,'primitives':[{'attributes':{'POSITION':0,'NORMAL':1},'indices':idx,'material':len(materials)-1}]})
    nodes.append({'name':name,'mesh':len(meshes)-1,'scale':scale,'translation':translation})
model={'asset':{'version':'2.0','generator':'EduNova original educational geometry (CC0)'},'scene':0,'scenes':[{'nodes':list(range(len(nodes)))}],'nodes':nodes,'meshes':meshes,'materials':materials,'buffers':[{'byteLength':len(blob)}],'bufferViews':views,'accessors':[
 {'bufferView':0,'componentType':5126,'count':len(positions)//3,'type':'VEC3','min':[-1,-1,-1],'max':[1,1,1]},
 {'bufferView':1,'componentType':5126,'count':len(normals)//3,'type':'VEC3'},
 {'bufferView':2,'componentType':5123,'count':len(indices),'type':'SCALAR'},
 {'bufferView':3,'componentType':5123,'count':len(cut_indices),'type':'SCALAR'}]}
js=json.dumps(model,separators=(',',':')).encode();js+=b' '*((-len(js))%4);blob+=b'\0'*((-len(blob))%4)
body=struct.pack('<I4s',len(js),b'JSON')+js+struct.pack('<I4s',len(blob),b'BIN\0')+blob
path=ROOT/'frontend/public/ar-assets/human-eye.glb'
path.write_bytes(struct.pack('<4sII',b'glTF',2,len(body)+12)+body)
lesson={'slug':'human-eye','subjectId':'physics','subject':'Physics','syllabusTopicId':'human-eye','topic':'Human Eye','title':'Human Eye: light to sight','description':'Explore how light enters the eye, is focused by the lens, and reaches the retina. This enlarged low-poly cutaway is a teaching schematic, not a medical or anatomically scaled model.','modelUrl':'/ar-assets/human-eye.glb','fallbackImage':'/ar-assets/human-eye.svg','assetBytes':path.stat().st_size,'learningObjectives':['Trace light from the pupil through the lens to the retina.','Explain how the lens focuses light.','Distinguish the retina and optic nerve.'],'hotspots':[
 {'id':'retina','label':'Retina','position':[-.10,.07,.03],'description':'Light-sensitive tissue at the back of the eye. Photoreceptors convert light into signals that travel through retinal circuits.','aiContext':'Explain rods and cones, light detection and how signals reach the optic nerve.'},
 {'id':'lens','label':'Lens','position':[.065,.065,.045],'description':'The transparent lens changes shape to help focus light on the retina.','aiContext':'Explain refraction, accommodation, and focusing near or distant objects.'},
 {'id':'pupil','label':'Pupil','position':[.127,.012,.025],'description':'The opening in the iris through which light enters the eye. The iris changes its size.','aiContext':'Distinguish the pupil (opening) from the iris (muscular tissue).'},
 {'id':'optic-nerve','label':'Optic nerve','position':[-.20,-.005,.015],'description':'Axons of retinal ganglion cells carry visual signals from the eye toward the brain.','aiContext':'Photoreceptors detect light; the optic nerve transmits signals, not light rays.'}
]}
(ROOT/'server/catalog/ar-lessons.json').write_text(json.dumps([lesson],indent=2)+'\n')
print(path.name,path.stat().st_size,'bytes')
