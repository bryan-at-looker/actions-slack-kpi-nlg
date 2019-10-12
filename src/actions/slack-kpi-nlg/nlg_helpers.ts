var numeral = require('numeral');

export function min (data: any) {
  return `_${data.dates[data.min_index]}_ had the lowest of *${data.combined_rendered[data.min_index]}*`
}

export function max (data: any) {
  return `The highest was *${data.combined_rendered[data.max_index]}* on _${data.dates[data.max_index]}_`
}

export function periods (data: any) {
  const end = data.this_period_dates.length-1
  const percent_verb = (data.totals_period_over_period_growth.value < 0) ? 'shrunk' : 'grew'
  return `This period _(${data.this_period_dates[0]} to ${data.this_period_dates[end]})_ *${percent_verb}* by *${data.totals_period_over_period_growth.rendered}* over the previous period _(${data.previous_period_dates[0]} to ${data.previous_period_dates[end]})_`
}

export function period_growth (data: any, type: string) {

  if (data.inferred_period_grain === 'days') {

    const this_period_day_over_day = data.this_period.map((row: any, i: any) => {
      if (i===0) { return null }
      return row / data.this_period[i-1] - 1
    })
    if (type === 'max') {
      var ind = this_period_day_over_day.indexOf(Math.max(...this_period_day_over_day));
    } else {
      var ind = this_period_day_over_day.indexOf(Math.min(...this_period_day_over_day));
    }

    return `_${data.this_period_dates[ind]}_ had the *${(type==='max')?'highest':'lowest'}* day over day growth: *${numeral(this_period_day_over_day[ind]).format('0.00%')}*`

  } else {

    return ``

  }
}