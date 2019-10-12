var numeral = require('numeral')
const { sortBy } = require('lodash')

export function createDataStructure (request: any) {
  var data = request.attachment.dataJSON

  const this_period = 'This Period'
  const previous_period = 'Previous Period'

  // TODO identify other time periods, not hard code date
  
  
  var out: any = {
    dates: [],
    previous_period: [],
    previous_period_rendered: [],
    previous_period_dates: [],
    this_period: [],
    this_period_rendered: [],
    this_period_dates: []
  };
  
  const dimension = data.fields.dimensions[0];
  const measure = data.fields.measures[0];

  // TODO create a function that smartly determines what the grain is
  out['inferred_period_grain'] = inferGrain(data.dates)
  
  const sorted = sortBy(data.data, (o: any) => { return o[dimension.name].value })
  
  sorted.forEach( ( row: any )=>{

    if (row[measure.name][previous_period]['value'] ) {
      out.previous_period_dates.push(row[dimension.name]['rendered'] || row[dimension.name]['value'])
      out.previous_period.push(row[measure.name][previous_period]['value']);
      out.previous_period_rendered.push(row[measure.name][previous_period]['rendered'] || row[measure.name][previous_period]['value']);
    }

    if (row[measure.name][this_period]['value']) {
      out.this_period_dates.push(row[dimension.name]['rendered'] || row[dimension.name]['value'])
      out.this_period.push(row[measure.name][this_period]['value']);
      out.this_period_rendered.push(row[measure.name][this_period]['rendered'] || row[measure.name][this_period]['value']);
    }

    out.dates.push(row[dimension.name]['rendered'] || row[dimension.name]['value'])

  })
  out.combined = out.previous_period.concat(out.this_period);
  out.combined_rendered = out.previous_period_rendered.concat(out.this_period_rendered);


  // create both value and rendered objects
  out['min_index'] = out.combined.indexOf(Math.min(...out.combined))
  out['max_index'] = out.combined.indexOf(Math.max(...out.combined))
  out['min'] = { value: Math.min(...out.combined), rendered: out.combined_rendered[out['min_index']] || Math.min(...out.combined) }
  out['max'] = { value: Math.max(...out.combined), rendered: out.combined_rendered[out['max_index']] || Math.max(...out.combined) }
  out['normalized_previous_period'] = out.previous_period.map ((o: any)=> { return (( parseFloat(o) - out.min.value ) / out.max.value) } )
  out['normalized_this_period'] = out.this_period.map ((o: any)=> { return ( ( parseFloat(o) - out.min.value ) / out.max.value  ) } )
  
  // totals
  out['totals_this_period'] = {
    value: data.totals_data[measure.name][this_period].value,
    // rendered: || data.totals_data[measure.name][this_period].value
  }
  out['totals_previous_period'] = {
    value: data.totals_data[measure.name][previous_period].value,
  }
  out['totals_period_over_period_growth'] = {
    value: out.totals_this_period.value / out.totals_previous_period.value - 1,
    rendered: numeral(out.totals_this_period.value / out.totals_previous_period.value - 1).format('0.00%')
  } 
  
  out['measure'] = {name: measure.name, label: measure.label_short || measure.short }

  return out
}

function inferGrain (_dates: any) {
  // TODO create a function that smartly determines what the grain is
  // if (!dates) {return ''}
  return 'days'
}